import React, { useRef, useState } from 'react';
import { BookOpen, Library, Trash2, Upload } from 'lucide-react';
import { TavernDialog, TavernImportDialog } from './TavernDialogs';
import './tavern-lore-library.css';

export default function TavernLoreLibrary({
  books, characters, initialCharacterId, onImportBook, onSetBinding, onDeleteBook, onClose,
}) {
  const [selectedId, setSelectedId] = useState(initialCharacterId || '');
  const [importing, setImporting] = useState(false);
  const [deleteId, setDeleteId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const saving = useRef(false);
  const character = characters.find(item => item.id === selectedId);
  const selectedBook = books.find(book => book.id === deleteId);
  const names = new Map(characters.map(item => [item.id, item.name]));

  async function save(action, success) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      setDeleteId(null);
    } catch (reason) {
      setError(reason?.message || '更改未能保存，请重试。');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <>
    <TavernDialog title="世界书库" eyebrow="LORE LIBRARY" icon={Library}
      onClose={() => { if (!saving.current) onClose(); }}>
      <div className="tv-dialog-body tv-lore-library">
        <div className="tv-lore-intro">
          <p>独立世界书可以绑定给多位角色。角色卡自带的世界书随角色一起导入。</p>
          <button type="button" data-initial-focus className="tv-button tv-button-primary" disabled={busy}
            onClick={() => { setError(''); setNotice(''); setDeleteId(null); setImporting(true); }}>
            <Upload size={16} aria-hidden="true" />导入世界书
          </button>
        </div>
        <label className="tv-field">
          <span className="tv-field-label">绑定角色</span>
          <select value={character?.id || ''} disabled={busy} onChange={event => {
            setSelectedId(event.target.value); setDeleteId(null); setError(''); setNotice('');
          }}>
            <option value="">仅管理世界书</option>
            {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="tv-library-books-head"><h3>已导入的世界书</h3><span>{books.length} 本</span></div>
        {character && <p className="tv-field-hint tv-lore-hint">勾选即可绑定给{character.name}，取消勾选即可解绑。</p>}
        {!books.length ? <p className="tv-library-empty"><BookOpen size={19} aria-hidden="true" />还没有独立世界书。</p> :
          <ul className="tv-library-books">
            {books.map(book => {
              const attachedNames = book.characterIds.map(id => names.get(id)).filter(Boolean);
              const label = <span className="tv-lore-book-info"><strong>{book.name}</strong>
                <small>{book.entries.length} 条设定 · {attachedNames.length ? '已绑定 ' + attachedNames.join('、') : '尚未绑定角色'}</small>
              </span>;
              return <li key={book.id}>
                {character ? <label className="tv-lore-book">
                  <input type="checkbox" aria-label={`将《${book.name}》绑定给${character.name}`}
                    checked={book.characterIds.includes(character.id)} disabled={busy}
                    onChange={event => {
                      const enabled = event.target.checked;
                      void save(() => onSetBinding(book.id, character.id, enabled),
                        enabled ? `《${book.name}》已绑定给${character.name}。` : `已解除${character.name}与《${book.name}》的绑定。`);
                    }} />
                  {label}
                </label> : <div className="tv-lore-book"><BookOpen size={17} aria-hidden="true" />{label}</div>}
                <button type="button" className="tv-icon-button" disabled={busy}
                  aria-label={`删除《${book.name}》`} title="删除世界书"
                  onClick={() => { setError(''); setNotice(''); setDeleteId(book.id); }}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>;
            })}
          </ul>}
        {error && <p className="tv-form-error" role="alert">{error}</p>}
        {notice && <p className="tv-save-status" role="status">{notice}</p>}
      </div>
    </TavernDialog>
    {importing && <TavernImportDialog kind="lorebook" onClose={() => setImporting(false)} onImport={async parsed => {
      await onImportBook(parsed, character?.id || null);
      setImporting(false);
      setNotice(character ? `已导入《${parsed.name}》并绑定给${character.name}。` : `已导入《${parsed.name}》。`);
    }} />}
    {selectedBook && <TavernDialog title="删除世界书" eyebrow="LORE LIBRARY" icon={Trash2}
      onClose={() => { if (!saving.current) { setDeleteId(null); setError(''); } }}>
      <div className="tv-dialog-body">
        <p className="tv-lore-delete-copy">从世界书库删除《{selectedBook.name}》？这本书与角色的绑定也会一并解除。</p>
        {error && <p className="tv-form-error" role="alert">{error}</p>}
      </div>
      <footer className="tv-dialog-footer">
        <button type="button" data-initial-focus className="tv-button tv-button-secondary" disabled={busy}
          onClick={() => { setDeleteId(null); setError(''); }}>取消</button>
        <button type="button" className="tv-button tv-button-danger" disabled={busy}
          onClick={() => void save(() => onDeleteBook(selectedBook.id), `已删除《${selectedBook.name}》。`)}>
          {busy ? '正在删除…' : '确认删除'}
        </button>
      </footer>
    </TavernDialog>}
  </>;
}
