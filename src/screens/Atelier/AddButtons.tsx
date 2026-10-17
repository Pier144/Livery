import { ChevronDown, Circle, Construction, Hexagon, Plus, Shapes, Square, Star } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { DEFAULT_FONT, HAZARD_ASPECT, type FontRef, type ShapeKind } from '@/atelier/project';
import { measureTextAspect } from '@/atelier/text';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { baseName } from '@/lib/format';
import { isTauri, toAppError } from '@/lib/tauri';
import { importImage, useFonts } from '@/queries/atelier';
import { toast } from '@/store/toasts';
import type { AssetRef } from '@/types';
import { noteAssetSize } from './decalUi';
import { BAR_BUTTON } from './LayerRows';

/** Pictures Add image offers (the backend imports the same). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'];

/** The file name without its extension (a new picture layer's name). */
function pictureName(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, '');
}

/** The font a new text layer starts with: Arial when installed, else the first one listed. */
function startFont(fonts: readonly FontRef[] | undefined): FontRef {
  if (!fonts || fonts.length === 0) return DEFAULT_FONT;
  const arial = fonts.find((f) => f.family === DEFAULT_FONT.family && f.style === DEFAULT_FONT.style);
  const regular = fonts.find((f) => f.style === 'Regular');
  const pick = arial ?? regular ?? fonts[0]!;
  return { family: pick.family, style: pick.style };
}

const SHAPE_ITEMS: { shape: ShapeKind; Icon: typeof Square }[] = [
  { shape: 'rect', Icon: Square },
  { shape: 'ellipse', Icon: Circle },
  { shape: 'star', Icon: Star },
  { shape: 'polygon', Icon: Hexagon },
];

/**
 * Add image, Add text and Add shape: the new layer waits for its placement click on the model.
 * Add image picks a picture with the system dialog (in the dev mock, a file input: the mock's
 * import makes its own picture from the name), imports it into the project's assets and waits.
 */
export function AddButtons() {
  const { t } = useTranslation();
  const projectId = useAtelierEditor((s) => s.project?.id ?? null);
  const fonts = useFonts();
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const startImage = (asset: AssetRef, name: string) => {
    noteAssetSize(asset.id, asset.width, asset.height);
    useAtelierEditor.getState().beginPlacement({ kind: 'image', assetId: asset.id, aspect: asset.width / asset.height, name });
  };

  const importPath = async (path: string) => {
    if (!projectId) return;
    setImporting(true);
    try {
      startImage(await importImage(projectId, path), pictureName(path));
    } catch (e) {
      toast(errorText(toAppError(e), t));
    } finally {
      setImporting(false);
    }
  };

  const addImage = async () => {
    if (!isTauri()) {
      fileRef.current?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, title: t('atelier.layers.addImage'), filters: [{ name: t('atelier.layers.imageFilter'), extensions: IMAGE_EXTENSIONS }] });
      if (typeof picked === 'string') await importPath(picked);
    } catch (e) {
      toast(errorText(toAppError(e), t));
    }
  };

  const addText = () => {
    const text = t('atelier.text.default');
    const font = startFont(fonts.data);
    const aspect = measureTextAspect({ text, font, outlineWidth: 0, skew: 0 }) ?? text.length * 0.6;
    useAtelierEditor.getState().beginPlacement({ kind: 'text', text, font, aspect });
  };

  const addShape = (value: string) => {
    const begin = useAtelierEditor.getState().beginPlacement;
    if (value === 'hazard') begin({ kind: 'shape', shape: 'rect', hazard: true, name: t('atelier.shape.hazard'), aspect: HAZARD_ASPECT });
    else begin({ kind: 'shape', shape: value as ShapeKind, aspect: 1 });
  };

  const shapeLabel = (shape: ShapeKind) => t(`atelier.shape.${shape}`);
  const itemLabel = (Icon: typeof Square, text: string) => (
    <span className="flex items-center gap-2">
      <Icon size={14} strokeWidth={1.75} aria-hidden className="flex-none text-ink-4" />
      {text}
    </span>
  );
  // The Menu has no divider: Hazard stripe, a preset, simply comes last.
  const shapeItems: MenuItem[] = [
    ...SHAPE_ITEMS.map(({ shape, Icon }) => ({ value: shape, label: itemLabel(Icon, shapeLabel(shape)), textValue: shapeLabel(shape) })),
    { value: 'hazard', label: itemLabel(Construction, t('atelier.shape.hazard')), textValue: t('atelier.shape.hazard') },
  ];

  return (
    <div className="flex gap-1.5">
      {/* Short visible labels (the panel is narrow in every language); the names say "Add …". */}
      <button
        type="button"
        onClick={() => void addImage()}
        disabled={!projectId || importing}
        aria-busy={importing || undefined}
        aria-label={t('atelier.layers.addImage')}
        title={t('atelier.layers.addImage')}
        className={cn(BAR_BUTTON, 'flex-1 px-2')}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
        <span className="truncate">{t('atelier.layers.image')}</span>
      </button>
      <button type="button" onClick={addText} disabled={!projectId} aria-label={t('atelier.layers.addText')} title={t('atelier.layers.addText')} className={cn(BAR_BUTTON, 'flex-1 px-2')}>
        <Plus size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
        <span className="truncate">{t('atelier.layers.text')}</span>
      </button>
      <Menu
        className="flex-none"
        label={t('atelier.layers.addShape')}
        align="end"
        menuWidthClass="min-w-[150px]"
        items={shapeItems}
        onSelect={addShape}
        renderTrigger={(props) => (
          // Icon only: Image and Text keep their words in the narrow panel; the name says "Add shape".
          <button {...props} disabled={!projectId} aria-label={t('atelier.layers.addShape')} title={t('atelier.layers.addShape')} className={cn(BAR_BUTTON, 'flex-none gap-0.5 px-1.5')}>
            <Shapes size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden className="flex-none text-ink-4" />
          </button>
        )}
      />
      {/* The browser has no file paths: `pnpm dev:mock` only (dropped from the production build). */}
      {import.meta.env.VITE_MOCK_BACKEND === '1' && !isTauri() && (
        <input
          ref={fileRef}
          type="file"
          hidden
          tabIndex={-1}
          aria-hidden
          accept={IMAGE_EXTENSIONS.map((e) => `.${e}`).join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importPath(`C:/Users/mock/Pictures/${file.name}`);
          }}
        />
      )}
    </div>
  );
}
