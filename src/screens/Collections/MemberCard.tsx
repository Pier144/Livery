import { useTranslation } from 'react-i18next';
import type { HangarSkin } from '@/types';

interface MemberCardProps {
  skin: HangarSkin;
  onRemove: () => void;
}

/** A skin in the open collection: 16:9 placeholder, name, vehicle and a "Remove" link. */
export function MemberCard({ skin, onRemove }: MemberCardProps) {
  const { t } = useTranslation();
  // A folder without a .blk has no vehicle code (the backend's name for it is English-only).
  const vehicle = skin.vehicle.code ? skin.vehicle.name || skin.vehicle.code : t('hangar.unknownVehicle');
  return (
    <li className="flex flex-col overflow-hidden rounded-card border border-line-2 bg-bg-3">
      {/* TODO(M5): the skin's screenshot when it came from WT Live. */}
      <div aria-hidden className="aspect-video bg-placeholder" />
      <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5">
        <p className="truncate text-[13px] font-medium leading-[normal] text-ink-1" title={skin.name}>
          {skin.name}
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] leading-[normal] text-ink-3" title={vehicle}>
            {vehicle}
          </span>
          <button
            type="button"
            data-member-remove
            aria-label={t('collections.removeLabel', { name: skin.name })}
            onClick={onRemove}
            className="flex-none rounded-menu text-[11px] leading-[normal] text-ink-4 hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
          >
            {t('collections.remove')}
          </button>
        </div>
      </div>
    </li>
  );
}
