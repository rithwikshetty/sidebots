import type { Logo } from "@server/contract.ts";

/** A brand's logo, as a connection's or a provider's: its mark, in the brand's colour. A mark with no colour of its own takes the text's, so it shows in light and dark. */
export function BrandLogo({ logo, size }: { logo: Logo; size: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className="shrink-0">
      <path d={logo.path} fill={logo.color ?? "currentColor"} />
    </svg>
  );
}
