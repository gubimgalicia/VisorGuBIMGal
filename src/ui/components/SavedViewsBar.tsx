import React, { useState } from 'react';
import { BookmarkPlus, X } from 'lucide-react';
import type { SavedView } from '../viewer/savedViews';
import { t } from '../i18n';

interface SavedViewsBarProps {
  views: readonly SavedView[];
  nextIndex: number;
  onSave: (name: string) => void;
  onApply: (view: SavedView) => void;
  onDelete: (id: string) => void;
}

export const SavedViewsBar: React.FC<SavedViewsBarProps> = ({
  views,
  nextIndex,
  onSave,
  onApply,
  onDelete
}) => {
  const [name, setName] = useState('');

  const handleSave = () => {
    onSave(name);
    setName('');
  };

  return (
    <div className="saved-views-bar">
      <div className="display-bar-row">
        <span className="display-bar-label">{t('savedViews.label')}</span>
        <input
          type="text"
          className="select saved-view-name"
          placeholder={t('savedViews.defaultName', { index: nextIndex })}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleSave();
            }
          }}
          title={t('savedViews.nameTitle')}
        />
        <button
          type="button"
          className="btn btn-ghost btn-icon saved-view-add"
          onClick={handleSave}
          title={t('savedViews.saveTitle')}
        >
          <BookmarkPlus size={14} />
        </button>
      </div>

      {views.length > 0 && (
        <ul className="saved-views-list">
          {views.map((view) => (
            <li key={view.id} className="saved-view-item" data-id={view.id}>
              <button
                type="button"
                className="saved-view-apply"
                onClick={() => onApply(view)}
                title={t('savedViews.applyTitle', { name: view.name })}
              >
                {view.name}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon saved-view-delete"
                onClick={() => onDelete(view.id)}
                title={t('savedViews.deleteTitle', { name: view.name })}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
