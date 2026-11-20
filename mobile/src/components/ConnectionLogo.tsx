import Svg, { Path } from "react-native-svg";
import type { Logo } from "@server/contract";
import { useTheme } from "@/lib/theme";

/**
 * A connection's logo: its brand's mark, in the brand's colour. A mark with
 * no colour of its own takes the text's, so it shows in light and dark.
 */
export function ConnectionLogo({ logo, size }: { logo: Logo; size: number }) {
  const theme = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <Path d={logo.path} fill={logo.color ?? theme.ink} />
    </Svg>
  );
}
