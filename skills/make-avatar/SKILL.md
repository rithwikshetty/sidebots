---
name: make-avatar
description: Make a new animated pixel avatar for a Sidebots agent from a drawing, a photo or a description. Use when the person sends a drawing or picture for an avatar, asks for a new avatar or one that looks like something, or wants an avatar's look changed.
---

# Make avatar

An avatar is a 16 by 16 pixel character. You draw it once as a grid of letters. `render.ts`, next to this file, turns that grid into every animation frame and writes `avatar.json` and `spritesheet.png`.

## Steps

1. Pick a short name and a one-sentence description. If the person sent a drawing or photo, look at it and take the shape, colours and one or two signature details from it. A drawing is the person's own design, so keep its silhouette and colours as close as 16 by 16 pixels allow.
2. Make a folder `~/.sidebots/avatars/<id>/`, where `<id>` is the name in lowercase with hyphens.
3. Write `design.json` in that folder, following the format below.
4. Run `node <this skill's folder>/render.ts ~/.sidebots/avatars/<id>`. Fix any error it prints and run it again.
5. Open `spritesheet.png` and look at it. Check that the avatar reads as one clear character, that the eyes sit on the face in every row, and that nothing is cut off at the top. Redraw and render again until it does.
6. Reply that the avatar is ready, using its name.

## design.json

```json
{
  "id": "mochi",
  "displayName": "Mochi",
  "description": "A round pink slime with a little yellow bow.",
  "palette": { "o": "#5B2840", "d": "#C05686", "b": "#F06BA8", "l": "#F8B5D4", "c": "#FF8FB0", "a": "#FFD54A" },
  "grid": [
    "................",
    "........a.a.....",
    ".........a......",
    "......oooo......",
    "....oobbbboo....",
    "...obllbbbbbo...",
    "..oblbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    ".obbbbbbbbbbbbo.",
    ".obbbbbbbbbbbbo.",
    ".obcbbbbbbbbcbo.",
    ".obbbbbeebbbbbo.",
    ".odbbbbbbbbbbdo.",
    "..oddbbbbbbddo..",
    "...oooooooooo...",
    "................"
  ],
  "eyes": { "row": 8, "left": 5, "right": 9, "skin": "b" }
}
```

- `grid` is exactly 16 rows of exactly 16 characters. `.` is empty.
- Every other letter is a colour from `palette`. The usual set is `o` outline, `d` shade, `b` body, `l` highlight, `c` cheeks and `a` an accent, but any letters work. `e` (near-black ink) and `w` (white) are always available.
- `eyes` places two 2 by 2 eyes: the grid row of their top edge, the left column of each, and the palette letter of the skin around them. The renderer draws the eyes itself in every frame, so open, blinking, happy and crossed eyes all come from this.
- Leave the top four rows clear on the right-hand side. The renderer puts a heart or a sweat drop there.

## Making it look good

- One dark outline around the whole silhouette, one pixel wide.
- A highlight of two or three `l` pixels near the top left, and a row of `d` shade along the bottom.
- A silhouette you can recognise from the outline alone: ears, a tuft, an antenna, a cap.
- Four to six colours. More turns to mush at this size.
