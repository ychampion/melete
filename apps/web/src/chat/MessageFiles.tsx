/**
 * The files a person sent with a message, drawn above its words: a thumbnail
 * for a picture, a named tile for a document. Each opens the file itself in a
 * new tab.
 *
 * In a room set to show only what needs you, a file someone else posted comes
 * kept back, with its kind and no name. It shows as a plain tile that says
 * opening it is noted in the room's activity, which its members can read, and "Open the original" opens it
 * on purpose and shows it here.
 */
import {
  ATTACHMENT_KIND_WORDS,
  type AttachmentKept,
  type AttachmentView,
  attachmentSize,
} from '@melete/contracts/attachments';
import { useEffect, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { attachmentUrl, openOriginal } from './attachments.ts';
import './message-files.css';

const KIND_NAMES: Record<AttachmentView['kind'], string> = {
  image: 'Picture',
  pdf: 'PDF',
  docx: 'Word document',
  xlsx: 'Spreadsheet',
  csv: 'CSV',
  text: 'Text',
};

export function MessageFiles({
  files,
  base = '',
}: {
  files: readonly (AttachmentView | AttachmentKept)[];
  /** Where the files live when not in the person's own chat, as `attachmentUrl` takes it. */
  base?: string;
}) {
  if (!files.length) return null;
  return (
    <ul className="bubble-files" aria-label="Files sent">
      {files.map((file) => {
        if ('kept_back' in file)
          return (
            <li key={file.id}>
              <KeptFile file={file} base={base} />
            </li>
          );
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
              href={attachmentUrl(file.id, false, base)}
              target="_blank"
              rel="noopener noreferrer"
              title={`${file.name} · ${detail}`}
              aria-label={`Open ${file.name} (${detail})`}
            >
              {picture ? (
                <img src={attachmentUrl(file.id, true, base)} alt={file.name} loading="lazy" />
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

type Opened = { url: string; name: string; picture: boolean };

/** A file kept back: what kind it is, and a way to open the original on purpose. */
function KeptFile({ file, base }: { file: AttachmentKept; base: string }) {
  const picture = file.kind === 'image';
  const label = ATTACHMENT_KIND_WORDS[file.kind];
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  useEffect(() => () => (opened ? URL.revokeObjectURL(opened.url) : undefined), [opened]);

  const open = async () => {
    setOpening(true);
    setProblem(null);
    const result = await openOriginal(file.id, base);
    setOpening(false);
    if (!result.data) {
      setProblem(result.error ?? result.unavailable ?? 'Couldn’t open the original.');
      return;
    }
    setOpened({
      url: URL.createObjectURL(result.data.blob),
      name: result.data.name,
      picture: result.data.blob.type.startsWith('image/'),
    });
  };

  if (opened)
    return opened.picture ? (
      <a
        className="bubble-file"
        data-picture="true"
        href={opened.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open the picture in a new tab"
      >
        <img src={opened.url} alt="The original you opened" />
      </a>
    ) : (
      <a className="bubble-file" href={opened.url} download={opened.name}>
        <Icon name="fileText" size={18} />
        <span className="attach-name">
          <span className="attach-title">Download the original</span>
          <span className="attach-meta">{label}</span>
        </span>
      </a>
    );

  return (
    <div className="bubble-file bubble-file-kept">
      <Icon name={picture ? 'image' : 'fileText'} size={18} />
      <span className="attach-name">
        <span className="attach-title">{label}</span>
        <span className="attach-meta attach-note" role={problem ? 'alert' : undefined}>
          {problem ?? 'Opening it is noted in the room’s activity.'}
        </span>
      </span>
      <button type="button" className="kept-open" disabled={opening} onClick={open}>
        {opening ? 'Opening…' : 'Open the original'}
      </button>
    </div>
  );
}
