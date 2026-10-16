//! Background removal's pure parts: the model input (size, NCHW order, normalisation), the mask
//! (min-max), alpha from the mask with the source RGB untouched, the crop with its margin, the
//! preload error mapping, and the remover's guards (a runtime or model that isn't the pinned one,
//! cancel with nothing running).

use image::{Rgba, RgbaImage};
use livery_lib::atelier::cutout::{
    alpha_bbox, apply_mask, background_colour, decontaminate, normalise_mask, postprocess, preload_error, preprocess,
    with_margin, Cutout, RuntimeFiles, ALPHA_THRESHOLD, CROP_MARGIN, CUTOUT_FAILED, CUTOUT_NOT_READY,
    CUTOUT_RUNTIME_MISSING_DEPS, MEAN, SIDE, UNMIX_ALPHA,
};
use livery_lib::atelier::models::FileHash;
use livery_lib::atelier::sha256::{digest, hex};
use livery_lib::error::ErrorCode;
use livery_lib::model::PixelRect;

const PLANE: usize = (SIDE * SIDE) as usize;

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-5
}

#[test]
fn the_input_is_nchw_normalised_by_the_mean() {
    // A flat colour stays flat through any resize.
    let source = RgbaImage::from_pixel(37, 53, Rgba([255, 0, 51, 7]));
    let data = preprocess(&source);
    assert_eq!(data.len(), 3 * PLANE);
    let expected = [1.0 - MEAN[0], 0.0 - MEAN[1], 0.2 - MEAN[2]];
    for (c, want) in expected.iter().enumerate() {
        let plane = &data[c * PLANE..(c + 1) * PLANE];
        assert!(plane.iter().all(|&v| close(v, *want)), "channel {c}: {} vs {want}", plane[0]);
    }
}

#[test]
fn the_input_keeps_rows_and_columns_in_place() {
    // Left half white, right half black: column 0 bright, the last column dark, in every plane.
    let source =
        RgbaImage::from_fn(SIDE, SIDE, |x, _| if x < SIDE / 2 { Rgba([255; 4]) } else { Rgba([0, 0, 0, 255]) });
    let data = preprocess(&source);
    for c in 0..3 {
        let row = 5 * SIDE as usize;
        assert!(close(data[c * PLANE + row], 1.0 - MEAN[c]));
        assert!(close(data[c * PLANE + row + SIDE as usize - 1], -MEAN[c]));
    }
}

#[test]
fn the_mask_is_min_max_normalised() {
    assert_eq!(normalise_mask(&[-2.0, 0.0, 2.0, 1.0]), vec![0, 128, 255, 191]);
    // Flat or broken output: nothing.
    assert_eq!(normalise_mask(&[0.3, 0.3]), vec![0, 0]);
    assert_eq!(normalise_mask(&[f32::NAN, 1.0, 3.0]), vec![0, 0, 255]);
}

#[test]
fn alpha_comes_from_the_mask_and_rgb_stays() {
    // Colour under alpha 0 too: it must survive.
    let source = RgbaImage::from_fn(8, 4, |x, y| Rgba([x as u8 * 30, y as u8 * 60, 7, if x == 7 { 0 } else { 200 }]));
    let mut mask = vec![255u8; 16];
    mask[0] = 0; // top-left quarter of a 4² mask
    let out = apply_mask(&source, &mask, 4);
    for (a, b) in source.pixels().zip(out.pixels()) {
        assert_eq!(a.0[..3], b.0[..3]);
    }
    assert_eq!(out.get_pixel(6, 3)[3], 200);
    assert_eq!(out.get_pixel(7, 3)[3], 0);
    assert!(out.get_pixel(0, 0)[3] < 40);
}

#[test]
fn the_crop_is_the_alpha_box_plus_the_margin_clamped() {
    let mut picture = RgbaImage::new(200, 100);
    for (x, y) in [(50, 40), (120, 60), (80, 45)] {
        picture.put_pixel(x, y, Rgba([1, 2, 3, 255]));
    }
    // At the threshold: doesn't count.
    picture.put_pixel(5, 5, Rgba([0, 0, 0, ALPHA_THRESHOLD]));
    let bbox = alpha_bbox(&picture, ALPHA_THRESHOLD).unwrap();
    assert_eq!(bbox, PixelRect { x: 50, y: 40, w: 71, h: 21 });
    assert_eq!(with_margin(bbox, CROP_MARGIN, 200, 100), PixelRect { x: 34, y: 24, w: 103, h: 53 });
    // Near the edges the margin is clamped, never past the picture.
    assert_eq!(
        with_margin(PixelRect { x: 3, y: 90, w: 190, h: 10 }, 16, 200, 100),
        PixelRect { x: 0, y: 74, w: 200, h: 26 }
    );
    assert_eq!(alpha_bbox(&RgbaImage::new(4, 4), ALPHA_THRESHOLD), None);
}

#[test]
fn postprocess_crops_the_subject_and_keeps_its_colours() {
    // Source with a "subject" in the middle; a mask that is high there.
    let source = RgbaImage::from_fn(400, 300, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, 99, 255]));
    let mut plane = vec![-1.0f32; PLANE];
    for y in 300..700 {
        for x in 400..600 {
            plane[y * SIDE as usize + x] = 3.0;
        }
    }
    let (cut, crop) = postprocess(&source, &plane).unwrap();
    assert_eq!((cut.width(), cut.height()), (crop.w, crop.h));
    // Mask columns 400..600 of 1024 → about 156..234 of 400; rows 300..700 → about 88..205 of 300.
    assert!(crop.x.abs_diff(156 - CROP_MARGIN) <= 3, "{crop:?}");
    assert!(crop.y.abs_diff(88 - CROP_MARGIN) <= 3, "{crop:?}");
    assert!((crop.x + crop.w).abs_diff(234 + CROP_MARGIN) <= 3, "{crop:?}");
    assert!((crop.y + crop.h).abs_diff(205 + CROP_MARGIN) <= 3, "{crop:?}");
    for (x, y, px) in cut.enumerate_pixels() {
        let src = source.get_pixel(crop.x + x, crop.y + y);
        assert_eq!(px.0[..3], src.0[..3]);
    }
    // The margin is transparent, the middle opaque.
    assert!(cut.get_pixel(1, 1)[3] < ALPHA_THRESHOLD);
    assert_eq!(cut.get_pixel(crop.w / 2, crop.h / 2)[3], 255);
    // A flat mask finds nothing.
    assert!(postprocess(&source, &vec![0.5; PLANE]).is_none());
}

/// A red disc with a soft edge over flat blue, as a camera or renderer blends it: `source`
/// opaque, `masked` with the disc's coverage as alpha.
fn soft_disc(side: u32) -> (RgbaImage, RgbaImage) {
    let (red, blue) = ([230f32, 20.0, 10.0], [10f32, 40.0, 220.0]);
    let centre = side as f32 / 2.0;
    let coverage = |x: u32, y: u32| {
        let d = ((x as f32 + 0.5 - centre).powi(2) + (y as f32 + 0.5 - centre).powi(2)).sqrt();
        ((side as f32 * 0.35 - d) / 6.0 + 0.5).clamp(0.0, 1.0)
    };
    let source = RgbaImage::from_fn(side, side, |x, y| {
        let a = coverage(x, y);
        let mix = |c: usize| (red[c] * a + blue[c] * (1.0 - a)).round() as u8;
        Rgba([mix(0), mix(1), mix(2), 255])
    });
    let masked = RgbaImage::from_fn(side, side, |x, y| {
        let mut px = *source.get_pixel(x, y);
        px[3] = (coverage(x, y) * 255.0).round() as u8;
        px
    });
    (source, masked)
}

#[test]
fn a_uniform_background_is_found_and_taken_out_of_the_edges() {
    let (source, masked) = soft_disc(200);
    let bg = background_colour(&source, &masked).expect("uniform background");
    assert!(bg.iter().zip([10.0f32, 40.0, 220.0]).all(|(a, b)| (a - b).abs() < 1.0), "{bg:?}");
    let mut cut = masked.clone();
    decontaminate(&mut cut, bg);
    let mut edges = 0;
    for (before, after) in masked.pixels().zip(cut.pixels()) {
        let a = f32::from(before[3]) / 255.0;
        if a > UNMIX_ALPHA.0 && a < UNMIX_ALPHA.1 {
            edges += 1;
            // Red, not purple: the blue that leaked in is gone.
            assert!(after[0] >= 220 && after[2] <= 25, "{before:?} -> {after:?}");
        } else {
            assert_eq!(before, after);
        }
        assert_eq!(before[3], after[3]);
    }
    assert!(edges > 100, "{edges} edge pixels");
}

#[test]
fn a_busy_background_is_left_alone() {
    let (_, masked) = soft_disc(200);
    // Same alpha, but the background is noise.
    let noisy = RgbaImage::from_fn(200, 200, |x, y| {
        let v = ((x * 7919 + y * 104_729) % 256) as u8;
        Rgba([v, 255 - v, v / 2, 255])
    });
    assert!(background_colour(&noisy, &masked).is_none());
    // Too little background to judge.
    let all_subject = RgbaImage::from_pixel(50, 50, Rgba([200, 0, 0, 255]));
    assert!(background_colour(&all_subject, &all_subject).is_none());
}

#[test]
fn postprocess_cleans_the_edges_of_a_cut_on_flat_blue() {
    let side = 256;
    let (source, masked) = soft_disc(side);
    // The model's plane: the disc's coverage at 1024², as the mask the picture came from.
    let scale = side as f32 / SIDE as f32;
    let plane: Vec<f32> = (0..PLANE)
        .map(|i| {
            let (x, y) = ((i % SIDE as usize) as f32 * scale, (i / SIDE as usize) as f32 * scale);
            f32::from(masked.get_pixel((x as u32).min(side - 1), (y as u32).min(side - 1))[3]) / 255.0
        })
        .collect();
    let (cut, crop) = postprocess(&source, &plane).unwrap();
    let mut purple = 0;
    let mut edges = 0;
    for (x, y, px) in cut.enumerate_pixels() {
        let a = f32::from(px[3]) / 255.0;
        if a > 0.2 && a < 0.9 {
            edges += 1;
            let raw = source.get_pixel(crop.x + x, crop.y + y);
            // Bluer than the raw blend would be wrong; most edges end up clearly red.
            assert!(px[2] <= raw[2], "{raw:?} -> {px:?}");
            purple += usize::from(px[2] > 80);
        }
    }
    assert!(edges > 50, "{edges}");
    assert!(purple * 10 < edges, "{purple} of {edges} edge pixels still purple");
}

#[test]
fn a_missing_dependency_reads_as_the_vc_runtime() {
    let e = preload_error(126);
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, CUTOUT_RUNTIME_MISSING_DEPS));
    let e = preload_error(193);
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Internal, CUTOUT_FAILED));
}

#[test]
fn a_runtime_that_isnt_the_pinned_one_is_never_loaded() {
    let dir = temp("runtime");
    let dll = dir.join("onnxruntime.dll");
    std::fs::write(&dll, b"not the runtime").unwrap();
    let model = dir.join("model.onnx");
    std::fs::write(&model, b"the pinned model").unwrap();
    let cutout = Cutout::new();
    let (dll_hash, model_hash) = (FileHash { size: 15, sha256: "0".repeat(64) }, hash_of(b"the pinned model"));
    let files = RuntimeFiles { dll: &dll, dll_hash: &dll_hash, model: &model, model_hash: &model_hash };
    let mut steps = Vec::new();
    let e = cutout.run(&files, &RgbaImage::new(2, 2), &mut |s| steps.push(s)).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, CUTOUT_NOT_READY));
    // Deleted, so the next download replaces it; nothing loaded; not left running; the model,
    // which matches, stays.
    assert!(!dll.exists());
    assert!(model.exists());
    assert!(!cutout.runtime_loaded());
    assert!(!cutout.is_running());
    // A cancel with nothing running does nothing.
    cutout.cancel();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_model_that_isnt_the_pinned_one_is_deleted_before_anything_loads() {
    let dir = temp("model");
    let dll = dir.join("onnxruntime.dll");
    std::fs::write(&dll, b"some runtime").unwrap();
    let model = dir.join("model.onnx");
    // Same size as the pinned bytes, other content.
    std::fs::write(&model, b"the other model!").unwrap();
    let cutout = Cutout::new();
    let (dll_hash, model_hash) = (hash_of(b"some runtime"), hash_of(b"the pinned model"));
    assert_eq!(model_hash.size, 16);
    let files = RuntimeFiles { dll: &dll, dll_hash: &dll_hash, model: &model, model_hash: &model_hash };
    let e = cutout.run(&files, &RgbaImage::new(2, 2), &mut |_| {}).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, CUTOUT_NOT_READY));
    assert!(!model.exists());
    // The runtime wasn't even looked at.
    assert!(dll.exists());
    assert!(!cutout.runtime_loaded());
    // Missing now: still not ready.
    let e = cutout.run(&files, &RgbaImage::new(2, 2), &mut |_| {}).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, CUTOUT_NOT_READY));
    let _ = std::fs::remove_dir_all(&dir);
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("livery-cutout-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hash_of(bytes: &[u8]) -> FileHash {
    FileHash { size: bytes.len() as u64, sha256: hex(&digest(bytes)) }
}
