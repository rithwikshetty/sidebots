// The files the scripted agents send and the seed fills chats with, all made
// in code so the harness needs nothing on disk: pictures as PNGs, a PDF, a
// CSV, a text file, a zip, and pages that use the chat's colours.

import { crc32, deflateSync } from "node:zlib";

/** A file as an agent sends one: its name, which the chat shows, and its bytes. */
export type Made = { name: string; bytes: Uint8Array };

const text = (words: string): Uint8Array => new TextEncoder().encode(words);

// ---------------------------------------------------------------- pictures

type Rgb = [number, number, number];

/** One chunk of a PNG: its length, its type, its data and the CRC of the type and data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

/** A PNG of `width` by `height` pixels, each the colour `paint` gives it, in 8-bit RGB. */
export function png(width: number, height: number, paint: (x: number, y: number) => Rgb): Uint8Array {
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const at = y * row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * Math.min(1, Math.max(0, t)))) as Rgb;

/** A sunset over hills, wide. */
function sunset(width: number, height: number): (x: number, y: number) => Rgb {
  const sun = { x: width * 0.68, y: height * 0.52, r: height * 0.11 };
  return (x, y) => {
    const far = height * (0.62 + 0.05 * Math.sin(x / width * 5.2));
    const near = height * (0.74 + 0.07 * Math.sin(x / width * 3.1 + 1.7));
    if (y > near) return mix([46, 74, 52], [24, 40, 30], (y - near) / (height - near));
    if (y > far) return mix([92, 96, 120], [64, 70, 96], (y - far) / (near - far));
    if (Math.hypot(x - sun.x, y - sun.y) < sun.r) return [255, 214, 140];
    return mix([44, 46, 112], [242, 140, 90], y / far);
  };
}

/** A mountain lake, tall, with the mountain reflected in the water. */
function lake(width: number, height: number): (x: number, y: number) => Rgb {
  const shore = height * 0.58;
  const peak = (x: number) => height * (0.22 + 0.3 * Math.abs((x / width) * 2 - 1.05));
  return (x, y) => {
    const mirrored = y > shore ? 2 * shore - y : y;
    const ground = mirrored > peak(x);
    const snow = ground && mirrored < peak(x) + height * 0.05;
    const color: Rgb = snow ? [236, 240, 246] : ground ? mix([88, 104, 128], [52, 70, 86], (mirrored - peak(x)) / (shore - peak(x))) : mix([132, 182, 230], [214, 232, 246], mirrored / shore);
    return y > shore ? mix(color, [30, 70, 100], 0.35 + 0.05 * Math.sin(y / 3)) : color;
  };
}

/** A fruit stall from above, square: oranges, limes and plums on a wooden table. */
function fruit(width: number, height: number): (x: number, y: number) => Rgb {
  const kinds: Rgb[] = [
    [240, 140, 40],
    [130, 190, 60],
    [120, 50, 110],
  ];
  const size = width / 6;
  return (x, y) => {
    const [column, line] = [Math.floor(x / size), Math.floor(y / size)];
    const [cx, cy] = [(column + 0.5) * size + ((line % 2) * size) / 4, (line + 0.5) * size];
    const d = Math.hypot(x - cx, y - cy) / (size * 0.42);
    if (d < 1) return mix(kinds[(column + line) % 3], [255, 255, 255], d < 0.35 && x < cx && y < cy ? 0.35 : 0);
    return mix([150, 104, 66], [118, 80, 50], 0.5 + 0.5 * Math.sin(y / 9 + Math.sin(x / 40)));
  };
}

/** A paper receipt on a dark table, tall. */
function receipt(width: number, height: number): (x: number, y: number) => Rgb {
  const [left, right] = [width * 0.18, width * 0.82];
  return (x, y) => {
    if (x < left || x > right || y < height * 0.06 || y > height * 0.94) return mix([44, 40, 38], [30, 28, 26], y / height);
    const line = Math.floor((y - height * 0.12) / (height * 0.045));
    const inLine = (y - height * 0.12) % (height * 0.045) < height * 0.014;
    const long = left + (right - left) * (line % 3 === 0 ? 0.62 : 0.44);
    if (line >= 0 && line < 15 && inLine && x > left + width * 0.06 && (x < long || x > right - width * 0.16)) return [70, 70, 70];
    return [248, 246, 240];
  };
}

/** The pictures the agents send, each a different shape: wide, tall and square. */
export const PICTURES = [
  { name: "Sunset from the ferry.png", width: 1200, height: 800, paint: sunset },
  { name: "Lake at Hallstatt.png", width: 720, height: 1080, paint: lake },
  { name: "Fruit stall.png", width: 900, height: 900, paint: fruit },
  { name: "Hardware shop receipt.png", width: 600, height: 1000, paint: receipt },
];

/** The picture at `index` in PICTURES, round again past the end. */
export function picture(index: number): Made {
  const { name, width, height, paint } = PICTURES[index % PICTURES.length];
  return { name, bytes: png(width, height, paint(width, height)) };
}

// ---------------------------------------------------------------- documents

/** A one-page PDF with a title and lines of text, in Helvetica. */
export function pdf(name: string, title: string, lines: string[]): Made {
  const escape = (words: string) => words.replace(/[\\()]/g, "\\$&");
  const stream = [
    `BT /F2 22 Tf 56 770 Td (${escape(title)}) Tj ET`,
    ...lines.map((line, index) => `BT /F1 12 Tf 56 ${730 - index * 20} Td (${escape(line)}) Tj ET`),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let file = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(file));
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(file);
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, bytes: text(file) };
}

/** The plumber's invoice, as a PDF. */
export const invoice = (): Made =>
  pdf("Hughes and Son invoice.pdf", "Invoice 2026-114", [
    "Hughes & Son Plumbing, 14 Mill Lane",
    "",
    "Replace kitchen tap washer and cartridge          GBP 48.00",
    "Call-out                                          GBP 65.00",
    "Parts                                             GBP 22.50",
    "",
    "Total                                             GBP 135.50",
    "",
    "Paid by card. Thank you for your custom.",
  ]);

/** This month's budget, as a CSV. */
export const budget = (): Made => ({
  name: "November budget.csv",
  bytes: text(
    [
      "Category,Budget,Spent,Left",
      "Groceries,380.00,241.60,138.40",
      "Home,450.00,376.40,73.60",
      "Transport,120.00,88.10,31.90",
      "Eating out,150.00,162.35,-12.35",
      "Subscriptions,46.97,46.97,0.00",
      "Gifts,100.00,35.00,65.00",
    ].join("\n") + "\n",
  ),
});

/** A packing list, as plain text. */
export const packingList = (): Made => ({
  name: "Packing list.txt",
  bytes: text(
    "Lisbon, 3 nights\n\nPassports\nPhone chargers and the plug adaptor\nRaincoat (showers Saturday)\nWalking shoes\nSunglasses\nThe camera and its spare battery\nPrinted hotel booking, just in case\n",
  ),
});

/** A zip of the given files, stored without compression. */
export function zip(name: string, files: { name: string; words: string }[]): Made {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1 January 2026, midday, as DOS writes a date and a time.
  const [time, date] = [12 << 11, ((2026 - 1980) << 9) | (1 << 5) | 1];
  for (const file of files) {
    const data = Buffer.from(file.words);
    const fileName = Buffer.from(file.name);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return { name, bytes: new Uint8Array(Buffer.concat([...locals, directory, end])) };
}

/** The tickets for the Lisbon weekend, as a zip. */
export const tickets = (): Made =>
  zip("Lisbon tickets.zip", [
    { name: "Boarding pass out.txt", words: "TAP 1351  LHR 07:05 to LIS 09:40  Fri 5 Dec  Seat 14A\n" },
    { name: "Boarding pass back.txt", words: "TAP 1366  LIS 18:20 to LHR 20:55  Mon 8 Dec  Seat 9C\n" },
    { name: "Hotel.txt", words: "Casa do Largo, Alfama. 3 nights from Fri 5 Dec. Booking 88214-LX. Check-in from 15:00.\n" },
  ]);

// ---------------------------------------------------------------- pages

/** A page with the given body, as an agent writes one: one file, its styles inside it, coloured with the chat's CSS variables. */
function page(name: string, style: string, body: string): Made {
  const base = "body{font:16px/1.4 -apple-system,system-ui,sans-serif;padding:14px 16px}h2{font-size:15px;margin:0 0 8px;color:var(--ink2);font-weight:600;text-transform:uppercase;letter-spacing:.04em}a{color:var(--tint)}";
  return { name, bytes: text(`<!doctype html><html><head><meta charset="utf-8"><style>${base}${style}</style></head><body>${body}</body></html>`) };
}

/** A short itinerary for a weekend away. */
export const itinerary = (): Made =>
  page(
    "Lisbon weekend.html",
    ".day{display:grid;grid-template-columns:64px 1fr;gap:4px 12px;padding:10px 0;border-top:1px solid var(--line)}.day:first-of-type{border-top:0}.when{color:var(--ink2);font-size:14px}.pick{background:var(--field);border-radius:10px;padding:10px 12px;margin-top:10px}.pick b{color:var(--tint)}",
    `<h2>Three days</h2>
<div class="day"><span class="when">Fri</span><span>Land 09:40. Lunch at Time Out Market, then the 28 tram up to Alfama.</span></div>
<div class="day"><span class="when">Sat</span><span>Belém in the morning, pastéis at the bakery, sunset at the Miradouro da Graça.</span></div>
<div class="day"><span class="when">Sun</span><span>Train to Sintra, 40 minutes. Pena Palace opens at 9:30.</span></div>
<div class="pick"><b>Book ahead:</b> Pena Palace tickets sell out on weekends. <a href="https://www.parquesdesintra.pt/en/">Parques de Sintra</a></div>`,
  );

/** A tall page of flats to compare, a card for each. */
export const flats = (): Made => {
  const listings = [
    ["14 Weston St", "£1,950", "2 bed", "6 min to Brunswick station", "Balcony, newly painted"],
    ["2/88 Lygon St", "£1,780", "2 bed", "11 min to the tram", "Top floor, no lift"],
    ["7 Albert St", "£2,100", "3 bed", "4 min to the station", "Garden, allows pets"],
    ["31 Union St", "£1,690", "1 bed + study", "9 min to the tram", "Quiet street, small kitchen"],
    ["5/12 Victoria St", "£1,840", "2 bed", "7 min to the station", "Parking space included"],
    ["66 Barkly Sq", "£1,720", "2 bed", "3 min to the shops", "Above a café, can be noisy"],
  ];
  const cards = listings
    .map(
      ([street, rent, rooms, walk, note], index) =>
        `<div class="card${index === 2 ? " best" : ""}"><div class="top"><b>${street}</b><span class="rent">${rent}<small>/mo</small></span></div><div class="meta">${rooms} · ${walk}</div><div class="note">${note}</div>${index === 2 ? '<div class="tag">Best fit</div>' : ""}</div>`,
    )
    .join("\n");
  return page(
    "Flats in Brunswick.html",
    ".card{background:var(--field);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 10px;position:relative}.card.best{border-color:var(--tint)}.top{display:flex;justify-content:space-between;gap:8px}.rent{font-weight:600}.rent small{color:var(--ink2);font-weight:400}.meta{color:var(--ink2);font-size:14px;margin-top:4px}.note{margin-top:6px}.tag{position:absolute;top:-9px;right:12px;background:var(--tint);color:#fff;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px}",
    `<h2>Six to look at</h2>\n${cards}\n<p>All listed this week on <a href="https://www.domain.com.au/rent/brunswick-vic-3056/">Domain</a>. Viewings are mostly Saturday morning.</p>`,
  );
};

/** A bar chart of what the groceries cost each month. */
export const groceries = (): Made => {
  const months = [
    ["Jun", 356],
    ["Jul", 371],
    ["Aug", 340],
    ["Sep", 365],
    ["Oct", 382],
    ["Nov", 412],
  ] as const;
  const bars = months
    .map(([month, spent], index) => `<div class="bar"><span class="fill${index === months.length - 1 ? " now" : ""}" style="height:${Math.round((spent / 450) * 100)}%"></span><span class="label">${month}</span><span class="value">£${spent}</span></div>`)
    .join("");
  return page(
    "Grocery spending.html",
    ".chart{display:flex;align-items:flex-end;gap:10px;height:160px;padding-top:18px;border-bottom:1px solid var(--line)}.bar{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;position:relative}.fill{width:100%;background:var(--field);border-radius:6px 6px 0 0}.fill.now{background:var(--tint)}.label{position:absolute;bottom:-22px;font-size:13px;color:var(--ink2)}.value{font-size:12px;color:var(--ink2);margin-bottom:4px;order:-1}.foot{margin-top:30px;color:var(--ink2);font-size:14px}",
    `<h2>Groceries by month</h2><div class="chart">${bars}</div><p class="foot">November is up £30 on October, mostly the big shop before the visit.</p>`,
  );
};

/**
 * A page that tries to get out of its frame. It carries a web link, links
 * that aim at a new window and at the window itself, a link to a place
 * further down the page, a form, and a note of every navigation its frame
 * hears of, in `window.heard`. `window.tries` holds what it tries by itself,
 * each by name, for a test to set off.
 */
export const hostile = (): Made =>
  page(
    "Odd page.html",
    "p{margin:0 0 10px}.gap{height:900px}",
    `<h2>Links</h2>
<p><a id="web" href="https://example.com/guide">Open the guide</a></p>
<p><a id="blank" href="https://example.com/new-window" target="_blank">Open in a new window</a></p>
<p><a id="over" href="https://example.com/over-the-window" target="_top">Open over the window</a></p>
<p><a id="jump" href="#notes">Jump to the notes</a></p>
<form id="form" action="https://example.com/form" method="post"><input name="q" value="sent"></form>
<div class="gap"></div>
<h2 id="notes">Notes</h2>
<p>The end of the page.</p>
<script>
window.heard = [];
navigation.addEventListener("navigate", (event) => heard.push(event.destination.url));
navigation.onnavigate = (event) => heard.push(event.destination.url);
const link = (id) => document.getElementById(id);
window.tries = {
  move: () => { location.href = "https://example.com/moved"; },
  window: () => { try { top.location.href = "https://example.com/window"; } catch {} },
  click: () => link("web").click(),
  targets: () => { link("blank").click(); link("over").click(); },
  refresh: () => { const meta = document.createElement("meta"); meta.httpEquiv = "refresh"; meta.content = "0;url=https://example.com/refreshed"; document.head.append(meta); },
  open: () => { window.open("https://example.com/popup"); window.open("https://example.com/named", "elsewhere"); },
  submit: () => link("form").submit(),
  focus: () => setInterval(() => link("web").focus(), 50),
};
</script>`,
  );

/** The pages, by the word that asks for each. */
export const PAGES = { short: itinerary, tall: flats, chart: groceries, hostile };
