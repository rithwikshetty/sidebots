import { useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { ArrowUp, ChevronRight, Plus, Reply, Square, X } from "lucide-react";
import type { AgentWithLatest, Message } from "@server/contract.ts";
import { MAX_FILES, fileKind, fileMeta, isImage } from "@client/files.ts";
import { preview } from "@client/messages.ts";
import type { Beside } from "@client/suggestions.ts";
import { cn } from "../lib/cn.ts";
import type { AgentChanges } from "../lib/store.ts";
import { openPanel } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { Tooltip } from "../ui/Tooltip.tsx";
import { FileTile } from "./Attachments.tsx";
import { FILE_ICONS, usePreviews } from "./files.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { FlowDots } from "./WorkingLine.tsx";

/**
 * The message field at the foot of the chat: a round card with + at its
 * start, which opens the system's file picker, and at its end what the agent
 * answers with, which opens the panel that changes it, and the round Send in
 * the chat's colour. Empty, the card is one line, the
 * text between the buttons, with a name too long for it cut short. With text
 * or files in it, it opens: the text across its top, which grows from one
 * line to about eight and then scrolls, and the buttons in a row beneath.
 * Enter sends and Shift+Enter starts a new line; Enter while an input method
 * is still composing a character does neither. Picked files sit in a tray
 * above the text, each with a button that removes it, and a message can go
 * with only files. While the agent works and there is nothing to send, Send
 * is Stop. While Sidebots is out of reach nothing can be sent, and a line
 * above the card says so. A reply shows what it answers above the card,
 * which Cancel or Esc lets go of. Work the person started from the agent's
 * suggestions shows above the card too, while it has any, and opens the
 * agent's page, which lists it.
 */
export function Composer({
  field,
  agent,
  onSet,
  value,
  onChange,
  files,
  onAdd,
  onRemove,
  replyTo,
  onCancelReply,
  work,
  onSend,
  onStop,
  online,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  agent: AgentWithLatest;
  /** Changes what the agent answers with. */
  onSet: (changes: AgentChanges) => void;
  value: string;
  onChange: (text: string) => void;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (file: File) => void;
  replyTo: Message | null;
  onCancelReply: () => void;
  /** The work the agent does beside the chat, as the strip above the card says it. */
  work: Beside | undefined;
  onSend: () => void;
  /** Stops the agent's work. Given while the agent works. */
  onStop?: () => void;
  online: boolean;
}) {
  const { name } = agent;
  const picker = useRef<HTMLInputElement>(null);
  // With something in it, the card is open: the text across its top and the buttons in a row beneath.
  const open = value.length > 0 || files.length > 0;
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
      {work ? (
        <button
          type="button"
          onClick={() => openPanel({ kind: "agent", agentId: agent.id, tab: "work" })}
          className="mb-2 flex w-full animate-rise-in items-center gap-2.5 rounded-xl bg-field py-1.5 pr-1.5 pl-3 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--field),var(--ink)_4%)]"
          data-testid="work-strip"
        >
          <FlowDots count={3} size={4} running={work.running} className="shrink-0 gap-1 text-ink2" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{work.title}</p>
            <p key={work.state} className="truncate animate-fade-in text-sm text-ink2">
              {work.state}
              {work.more > 0 ? ` · ${work.more} more` : ""}
            </p>
          </div>
          <span className="grid size-8 shrink-0 place-items-center text-ink3">
            <ChevronRight aria-hidden className="size-4" strokeWidth={2} />
          </span>
        </button>
      ) : null}
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
        className="relative rounded-composer bg-raised shadow-control transition-shadow duration-150 focus-within:shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_var(--ring-color)]"
        data-testid="composer-card"
      >
        {files.length ? <Tray files={files} onRemove={onRemove} /> : null}
        <IconButton
          icon={Plus}
          label="Add files"
          onClick={() => picker.current?.click()}
          disabled={files.length >= MAX_FILES}
          tooltipSide="top"
          className="absolute bottom-1.5 left-1.5 size-8 rounded-full"
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
        {/* The text and the buttons at the card's end share one row. While the card is one line the text keeps to its own column, so it stops short of them; once it opens the text runs under both columns, with room beneath it for the buttons. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto]">
          <div
            onClick={(event) => event.target === event.currentTarget && field.current?.focus()}
            className={cn("col-start-1 row-start-1 flex cursor-text transition-[padding] duration-200 ease-out", open ? "col-span-2 px-2.5 pt-3 pb-10.5" : "py-2.75 pr-1 pl-10.5")}
          >
            <textarea
              ref={field}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              onKeyDown={keyDown}
              onPaste={paste}
              rows={1}
              placeholder={`Message ${name}`}
              aria-label={`Message ${name}`}
              className="field-sizing-content max-h-[8lh] min-w-0 flex-1 resize-none bg-transparent px-1 text-message text-ink outline-none placeholder:truncate placeholder:text-ink3"
              data-testid="message-field"
            />
          </div>
          <div className="col-start-2 row-start-1 mr-1.5 mb-1.5 flex items-center gap-1 self-end">
            <ModelPicker agent={agent} onSet={onSet} returnTo={field} />
            <Tooltip label={stops ? "Stop" : "Send"} shortcut={stops ? undefined : ["↩"]} side="top">
              <button
                type="button"
                onClick={() => (stops ? onStop?.() : canSend && onSend())}
                disabled={!canSend && !stops}
                aria-label={stops ? "Stop" : "Send message"}
                className="grid size-8 place-items-center rounded-full bg-chat text-on-tint transition-[opacity,filter,scale] duration-150 ease-out hover:brightness-110 active:scale-95 disabled:opacity-40"
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
