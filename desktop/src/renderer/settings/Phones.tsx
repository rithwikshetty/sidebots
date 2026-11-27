import { useEffect, useMemo, useState } from "react";
import { CircleCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import type { Phone, PhonePairing } from "../../bridge.ts";
import { problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { confirm } from "../ui/Confirm.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { Failure, Group, Loading, SectionTitle } from "./Group.tsx";

const SITE = "https://sidebots.app";
// How often the code's side looks whether a phone has paired with it, and whether it has run out.
const WATCH_MS = 2_000;
// How long Copy says the link was copied.
const COPIED_MS = 2_000;

/**
 * The phones paired with this computer, each with when it paired and a way
 * to remove it, and Pair a phone, which shows the code another phone scans.
 */
export function Phones() {
  const [phones, setPhones] = useState<Phone[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const reload = () =>
    window.desktop.phones().then(
      (listed) => {
        setPhones(listed);
        setFailure(null);
      },
      (reason) => setFailure(reason instanceof Error ? reason.message : "Something went wrong."),
    );
  useEffect(() => void reload(), []);

  async function remove(phone: Phone) {
    if (!(await confirm({ title: `Remove ${phone.name}?`, message: "It will need a new code to pair again.", action: "Remove", destructive: true }))) return;
    await window.desktop.removePhone(phone.id).catch((reason) => problem("Couldn't remove it", reason));
    await reload();
  }

  return (
    <>
      <SectionTitle>Phones</SectionTitle>
      <p className="mb-4 px-0.5 text-sm text-pretty text-ink2">Sidebots is also on iPhone and iPad. A phone you pair here has all your agents and their chats, wherever you are.</p>
      {phones ? (
        <div className="flex flex-col gap-4">
          <Group testId="phones">
            {phones.length ? (
              phones.map((phone) => (
                <div key={phone.id} className="flex items-center gap-3 px-3.5 py-3" data-testid={`phone-${phone.id}`}>
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-field text-ink2">
                    <Smartphone aria-hidden className="size-4" strokeWidth={2} />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span data-selectable className="truncate text-sm font-medium">
                      {phone.name}
                    </span>
                    <span className="text-xs text-ink2">{`Paired ${pairedWhen(phone.pairedAt)}`}</span>
                  </div>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void remove(phone)} aria-label={`Remove ${phone.name}`}>
                    Remove
                  </Button>
                </div>
              ))
            ) : (
              <p className="px-3.5 py-3 text-sm text-ink2">No phones yet</p>
            )}
          </Group>
          {pairing ? (
            <Pairing onPhones={setPhones} onDone={() => setPairing(false)} />
          ) : (
            <Button className="self-start" onClick={() => setPairing(true)} data-testid="pair-phone">
              Pair a phone
            </Button>
          )}
        </div>
      ) : failure ? (
        <Failure>{failure}</Failure>
      ) : (
        <Loading label="Loading phones" />
      )}
    </>
  );
}

/** When a phone paired, as "21 Nov 2026, 09:41", which tells apart two phones of one name. */
function pairedWhen(time: number): string {
  return new Date(time).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * The code a phone scans to pair, with its link to copy for a phone that
 * enters it instead. It makes a new code when the last one runs out, and
 * says when a phone has paired, with a way to pair another. `onPhones` hears
 * the phones each time it looks, so the list above keeps up. `leave` is what
 * the button that gives up on pairing says.
 */
export function Pairing({ onPhones, onDone, leave = "Cancel" }: { onPhones?: (phones: Phone[]) => void; onDone: () => void; leave?: string }) {
  const [code, setCode] = useState<PhonePairing | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [paired, setPaired] = useState<Phone | null>(null);

  useEffect(() => {
    if (paired) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let before: Set<string> | undefined;
    let current: PhonePairing | null = null;
    async function look() {
      const phones = await window.desktop.phones().catch(() => null);
      if (stopped) return;
      if (phones) {
        onPhones?.(phones);
        before ??= new Set(phones.map((phone) => phone.id));
        const fresh = phones.find((phone) => !before!.has(phone.id));
        if (fresh) return setPaired(fresh);
      }
      if (!current || current.expiresAt <= Date.now()) {
        try {
          current = await window.desktop.pairPhone();
          setTrouble(null);
        } catch (reason) {
          current = null;
          setTrouble(reason instanceof Error ? reason.message : "Something went wrong.");
        }
        if (stopped) return;
        setCode(current);
      }
      timer = setTimeout(() => void look(), WATCH_MS);
    }
    void look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [paired, onPhones]);

  if (paired) {
    return (
      <div role="status" className="flex animate-fade-in flex-col items-center gap-1.5 rounded-lg bg-canvas px-6 py-7 text-center shadow-control" data-testid="paired">
        <CircleCheck aria-hidden className="mb-2 size-10 text-ok" strokeWidth={1.75} />
        <h3 className="text-base font-semibold">{`Paired with ${paired.name}`}</h3>
        <p className="text-sm text-ink2">Your agents are on your phone now.</p>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => setPaired(null)}>Pair another phone</Button>
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-5 rounded-lg bg-canvas p-4 shadow-control" data-testid="pairing">
      <div className={cn("grid size-[184px] shrink-0 place-items-center rounded-lg p-3 transition-colors duration-200", code ? "bg-code-paper shadow-control" : "bg-field")}>
        {code ? (
          <QR link={code.link} />
        ) : (
          <span className="text-ink3">
            <Spinner size={20} label="Making a code" />
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="text-base font-semibold">Pair a phone</h3>
        <p className="mt-1 text-sm text-pretty text-ink2" role={trouble ? "alert" : undefined}>
          {trouble ?? "Open Sidebots on your phone and point its camera at this code."}
        </p>
        {code ? (
          <>
            <p className="mt-3 text-xs text-pretty text-ink2">Or choose Enter a link instead on your phone, and paste this link.</p>
            <CopyLink link={code.link} />
          </>
        ) : null}
        <p className="mt-auto pt-3 text-xs text-pretty text-ink2">
          No Sidebots on your phone yet?{" "}
          <button type="button" onClick={() => void window.desktop.openExternal(SITE)} className="rounded-xs text-tint-ink hover:underline">
            Get it from the App Store.
          </button>
        </p>
        <Button size="sm" className="mt-3 self-start" onClick={onDone}>
          {leave}
        </Button>
      </div>
    </div>
  );
}

/** The pairing link in one line, cut in the middle when it is long, with a button that copies it. */
function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () =>
    navigator.clipboard.writeText(link).then(
      () => setCopied(true),
      (reason) => problem("Couldn't copy the link", reason),
    );
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-md bg-field py-1 pr-1 pl-2.5">
      <span data-selectable className="min-w-0 flex-1 truncate font-mono text-xs text-ink2" title={link} data-testid="pairing-link">
        {link}
      </span>
      <Button size="sm" onClick={copy} className="min-w-16">
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** A link as a QR code, drawn as one path of squares, sharp at any size. */
function QR({ link }: { link: string }) {
  const { size, squares } = useMemo(() => {
    const { modules } = QRCode.create(link, { errorCorrectionLevel: "M" });
    let path = "";
    for (let row = 0; row < modules.size; row++) for (let column = 0; column < modules.size; column++) if (modules.get(row, column)) path += `M${column} ${row}h1v1h-1z`;
    return { size: modules.size, squares: path };
  }, [link]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label="QR code that pairs a phone" className="size-full animate-fade-in" data-testid="pairing-code">
      <path d={squares} className="fill-code-ink" />
    </svg>
  );
}
