//! Background removal's pure parts: the model input (size, NCHW order, normalisation), the mask
//! (min-max), alpha from the mask with the source RGB untouched, the crop with its margin, the
//! preload error mapping, and the remover's guards (not ready, cancel with nothing running).

use image::{Rgba, RgbaImage};
use livery_lib::atelier::cutout::{
    alpha_bbox, apply_mask, normalise_mask, postprocess, preload_error, preprocess, with_margin, Cutout,
    ALPHA_THRESHOLD, CROP_MARGIN, CUTOUT_FAILED, CUTOUT_NOT_READY, CUTOUT_RUNTIME_MISSING_DEPS, MEAN, SIDE,
};
use livery_lib::atelier::models::FileHash;
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

#[test]
fn a_missing_dependency_reads_as_the_vc_runtime() {
    let e = preload_error(126);
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, CUTOUT_RUNTIME_MISSING_DEPS));
    let e = preload_error(193);
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::Internal, CUTOUT_FAILED));
}

#[test]
fn a_runtime_that_isnt_the_pinned_one_is_never_loaded() {
    let dir = std::env::temp_dir().join(format!("livery-cutout-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let dll = dir.join("onnxruntime.dll");
    std::fs::write(&dll, b"not the runtime").unwrap();
    let cutout = Cutout::new();
    let hash = FileHash { size: 15, sha256: "0".repeat(64) };
    let mut steps = Vec::new();
    let e =
        cutout.run(&dll, &hash, &dir.join("model.onnx"), &RgbaImage::new(2, 2), &mut |s| steps.push(s)).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::NotFound, CUTOUT_NOT_READY));
    // Deleted, so the next download replaces it; nothing loaded; not left running.
    assert!(!dll.exists());
    assert!(!cutout.runtime_loaded());
    assert!(!cutout.is_running());
    // A cancel with nothing running does nothing.
    cutout.cancel();
    let _ = std::fs::remove_dir_all(&dir);
}
