/**
 * The files a person sent with a message, drawn above its words: a thumbnail
 * for a picture, a named tile for a document. Each opens the file itself in a
 * new tab.
 */
import { type AttachmentView, attachmentSize } from '@melete/contracts/attachments';
import { Icon } from '../design/icons.tsx';
import { attachmentUrl } from './attachments.ts';
import './message-files.css';

const KIND_NAMES: Record<AttachmentView['kind'], string> = {
  image: 'Picture',
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Spreadsheet',
  csv: 'CSV',
  text: 'Text',
};

export function MessageFiles({ files }: { files: readonly AttachmentView[] }) {
  if (!files.length) return null;
  return (
    <ul className="bubble-files" aria-label="Files sent">
      {files.map((file) => {
        const picture = file.kind === 'image' && file.has_preview;
        const detail = [
          KIND_NAMES[file.kind],
          file.kind === 'pdf' && file.pages ? `${file.pages} pages` : null,
          attachmentSize(file.size),
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={file.id}>
            <a
              className="bubble-file"
              data-picture={picture ? 'true' : undefined}
              href={attachmentUrl(file.id)}
              target="_blank"
              rel="noopener noreferrer"
              title={`${file.name} · ${detail}`}
              aria-label={`Open ${file.name} (${detail})`}
            >
              {picture ? (
                <img src={attachmentUrl(file.id, true)} alt={file.name} loading="lazy" />
              ) : (
                <>
                  <Icon name={file.kind === 'image' ? 'image' : 'fileText'} size={18} />
                  <span className="attach-name">
                    <span className="attach-title">{file.name}</span>
                    <span className="attach-meta">{detail}</span>
                  </span>
                </>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
