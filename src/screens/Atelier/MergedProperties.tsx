import { Info, Ungroup } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Decal, MergedLayer, Piece } from '@/atelier/project';
import { Button } from '@/components/ui/Button';
import { ImageContent, NotPlaced, OpacityRow, PlacementRows, TextContent, WearRow } from './DecalProperties';
import { useDecalUi } from './decalUi';
import { useLayerName } from './LayersPanel';
import { RepeatSection } from './RepeatSection';
import { useSelectionActions } from './selectionActions';
import { ShapeContent } from './ShapeProperties';

/**
 * A merged object's settings: the pieces it holds, the shared placement rows (no Wear: merged
 * objects have none of their own), its Repeat and Separate (which gives the layers back).
 */
export function MergedProperties({
  layer,
  checkShared,
  mirrorAxis,
}: {
  layer: MergedLayer;
  checkShared: (layerId: string, decal?: Decal) => Promise<boolean>;
  mirrorAxis: number;
}) {
  const { t } = useTranslation();
  const nameOf = useLayerName();
  const { separate } = useSelectionActions();
  // Top to bottom, as the Layers panel lists them.
  const pieces = [...layer.children].reverse();

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <p className="text-meta text-ink-3">{t('atelier.props.pieceCount', { count: layer.children.length })}</p>
        <ul className="flex flex-col gap-0.5">
          {pieces.map((piece) => (
            <li key={piece.id} className="truncate text-meta text-ink-2">
              {nameOf(piece, piece.kind)}
            </li>
          ))}
        </ul>
      </div>
      {layer.decal ? (
        <>
          <PlacementRows layer={layer} decal={layer.decal} checkShared={checkShared} />
          <RepeatSection layer={layer} mirrorAxis={mirrorAxis} />
        </>
      ) : (
        <NotPlaced id={layer.id} />
      )}
      <Button size={28} onClick={() => separate(layer.id)} className="self-start">
        <Ungroup size={14} strokeWidth={1.75} aria-hidden />
        {t('atelier.layers.separate')}
      </Button>
    </>
  );
}

/**
 * A piece of a merged object: its content (text, font and colours; flip for a picture; the shape's
 * options), opacity and wear. It has no placement or repeat of its own, and its picture can't be
 * cut out here: a note says to separate the object for that.
 */
export function PieceProperties({ piece }: { piece: Piece }) {
  const { t } = useTranslation();
  const missing = useDecalUi((s) => piece.kind === 'image' && s.missingAssets[piece.assetId] === true);
  useDecalUi((s) => s.fontsVersion);
  return (
    <>
      <p className="flex items-start gap-2 rounded-ctl border border-line-2 bg-bg-2 p-3 text-meta text-ink-2">
        <Info size={14} strokeWidth={1.75} aria-hidden className="mt-px flex-none text-ink-4" />
        {t('atelier.props.pieceNote')}
      </p>
      {piece.kind === 'image' ? <ImageContent layer={piece} missing={missing} /> : piece.kind === 'text' ? <TextContent layer={piece} /> : <ShapeContent layer={piece} />}
      <OpacityRow id={piece.id} opacity={piece.opacity} />
      <WearRow id={piece.id} wear={piece.wear} />
    </>
  );
}
