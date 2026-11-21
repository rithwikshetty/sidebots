import { useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { ArrowUp, Plus, Reply, Square, X } from "lucide-react";
import type { Message } from "@server/contract.ts";
import { MAX_FILES, fileKind, fileMeta, isImage } from "@client/files.ts";
import { preview } from "@client/messages.ts";
import { cn } from "../lib/cn.ts";
import { IconButton } from "../ui/Button.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { FileTile } from "./Attachments.tsx";
import { FILE_ICONS, usePreviews } from "./files.ts";

/**
 * The message field at the foot of the chat: a card with the text, which
 * grows from one line to about eight and then scrolls, + at its start, which
 * opens the system's file picker, and the round Send at its end in the chat's
 * colour. Enter sends and Shift+Enter starts a new line; Enter while an input
 * method is still composing a character does neither. Picked files sit in a
 * tray above the text, each with a button that removes it, and a message can
 * go with only files. While the agent works and there is nothing to send,
 * Send is Stop. While Sidebots is out of reach nothing can be sent, and a
 * line above the card says so. A reply shows what it answers above the card,
 * which Cancel or Esc lets go of.
 */
export function Composer({
  field,
  name,
  value,
  onChange,
  files,
  onAdd,
  onRemove,
  replyTo,
  onCancelReply,
  onSend,
  onStop,
  online,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  /** The agent's name, for the field's placeholder and the reply's words. */
  name: string;
  value: string;
  onChange: (text: string) => void;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (file: File) => void;
  replyTo: Message | null;
  onCancelReply: () => void;
  onSend: () => void;
  /** Stops the agent's work. Given while the agent works. */
  onStop?: () => void;
  online: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const canSend = online && (value.trim().length > 0 || files.length > 0);
  // With nothing to send, the button stops the agent's work instead.
  const stops = !canSend && online && onStop !== undefined && value.trim().length === 0 && files.length === 0;

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0) return;
    event.preventDefault();
    onAdd(pasted);
  };

  return (
    <div className="px-4 pb-4" data-testid="composer">
      {online ? null : (
        <p role="status" className="mb-2 animate-fade-in text-center text-sm text-ink2" data-testid="offline-line">
          Can't reach Sidebots on this computer.
        </p>
      )}
      {replyTo ? (
        <div className="mb-2 flex animate-rise-in items-center gap-2.5 rounded-xl bg-field py-1.5 pr-1.5 pl-3" data-testid="replying">
          <Reply aria-hidden className="size-4 shrink-0 text-ink2" strokeWidth={2} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Replying to {replyTo.sender === "person" ? "yourself" : name}</p>
            <p className="truncate text-sm text-ink2">{preview(replyTo)}</p>
          </div>
          <IconButton icon={X} label="Cancel reply" shortcut={["Esc"]} onClick={onCancelReply} data-testid="cancel-reply" />
        </div>
      ) : null}
      <div
        onClick={(event) => event.target === event.currentTarget && field.current?.focus()}
        className="rounded-bubble bg-raised shadow-control transition-shadow duration-150 focus-within:shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_var(--ring-color)]"
      >
        {files.length ? <Tray files={files} onRemove={onRemove} /> : null}
        <div className="flex items-end gap-1 p-1.5">
          <IconButton
            icon={Plus}
            label="Add files"
            onClick={() => picker.current?.click()}
            disabled={files.length >= MAX_FILES}
            tooltipSide="top"
            className="size-8 rounded-full"
            data-testid="add-files"
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              onAdd([...(event.currentTarget.files ?? [])]);
              event.currentTarget.value = "";
            }}
            data-testid="file-input"
          />
          <textarea
            ref={field}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={keyDown}
            onPaste={paste}
            rows={1}
            placeholder={`Message ${name}`}
            aria-label={`Message ${name}`}
            className="field-sizing-content max-h-[calc(8lh+12px)] min-h-8 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-message text-ink outline-none placeholder:text-ink3"
            data-testid="message-field"
          />
          <Tooltip label={stops ? "Stop" : "Send"} shortcut={stops ? undefined : ["↩"]} side="top">
            <button
              type="button"
              onClick={() => (stops ? onStop?.() : canSend && onSend())}
              disabled={!canSend && !stops}
              aria-label={stops ? "Stop" : "Send message"}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-chat text-on-tint transition-[opacity,filter,scale] duration-150 ease-out hover:brightness-110 active:scale-95 disabled:opacity-40"
              data-testid={stops ? "stop" : "send"}
            >
              {stops ? (
                <Square key="stop" aria-hidden className="size-3 animate-fade-in fill-current" strokeWidth={2.5} />
              ) : (
                <ArrowUp key="send" aria-hidden className="size-[18px] animate-fade-in" strokeWidth={2.5} />
              )}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

/** The files picked for the next message, above the text: a picture as a small square, any other file as a card with its kind's icon, its name, and its kind and size, each with a button that removes it. */
function Tray({ files, onRemove }: { files: File[]; onRemove: (file: File) => void }) {
  const previews = usePreviews(files);
  return (
    <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5 pb-1" data-testid="tray">
      {files.map((file, index) => (
        <div key={`${index}-${file.name}-${file.size}`} className="relative shrink-0 animate-fade-in" data-testid="tray-item">
          {isImage(file.name) ? (
            <div className="size-14 overflow-hidden rounded-lg bg-field" role="img" aria-label={file.name}>
              {previews.get(file) ? <img src={previews.get(file)} alt="" className="size-full object-cover" /> : null}
            </div>
          ) : (
            <FileTile icon={FILE_ICONS[fileKind(file.name)]} name={file.name} meta={fileMeta(file.name, file.size)} className="h-14 w-44 rounded-lg bg-canvas py-0 pr-6" />
          )}
          <button
            type="button"
            onClick={() => onRemove(file)}
            aria-label={`Remove ${file.name}`}
            className={cn("absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-ink text-canvas shadow-control transition-[scale,opacity] hover:scale-110 active:scale-95")}
            data-testid="remove-file"
          >
            <X aria-hidden className="size-3" strokeWidth={3} />
          </button>
        </div>
      ))}
    </div>
  );
}
