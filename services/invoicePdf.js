// Server-side invoice PDF (PDFKit). Reproduces the shared invoice layout:
// title, Invoice No/Date, To/From boxes, package + amounts key/values, the
// Payment Transaction table, and Terms.
//
// PDFKit's built-in Helvetica cannot render ₹ (U+20B9). If an embedded Unicode
// TTF that contains ₹ is present in assets/fonts, we use it and print ₹;
// otherwise we gracefully fall back to Helvetica and print "Rs.".
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { business, TERMS } from '../config/business.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, '..', 'assets');
const REG = path.join(ASSETS, 'fonts', 'Regular.ttf');
const BOLD = path.join(ASSETS, 'fonts', 'Bold.ttf');
const LOGO = path.join(ASSETS, 'logo.png');

// PDFKit's built-in Helvetica can't render ₹ (U+20B9). When the embedded
// Unicode TTF (DejaVu Sans, which includes ₹) is present we use it and print ₹;
// otherwise we fall back to Helvetica and print "Rs.".
const HAS_FONT = fs.existsSync(REG);
const RUPEE = HAS_FONT ? '₹' : 'Rs. ';

// Dark "fight-poster" palette: black page, white ink, muted-grey secondaries,
// a brightened red + brass accent that read on black. logo.png is a white skull
// on a solid-black field, so it blends seamlessly onto the page background.
const C = {
  bg:     '#000000', // page background (matches the logo's black field)
  red:    '#e0483a', // brightened accent so it pops on black
  accent: '#c9a24b', // brass, for section headers
  text:   '#ffffff', // primary ink
  muted:  '#b8b8b8', // secondary ink (addresses, labels)
  line:   '#3a3a3a', // hairlines / borders, visible on black
  fill:   '#1c1c1c', // table-header band
};
const PAGE = { left: 40, right: 555, top: 40, bottom: 800, width: 515 };
// Optional full composite: drop one at assets/invoice-hero.png to use it as the
// header banner instead of the natively-drawn crest + wordmark.
const HERO = path.join(ASSETS, 'invoice-hero.png');

function money(v) {
  return `${RUPEE}${(Number(v) || 0).toLocaleString('en-IN')}`;
}

function fonts(doc) {
  if (HAS_FONT) {
    doc.registerFont('body', REG);
    doc.registerFont('bold', fs.existsSync(BOLD) ? BOLD : REG);
  } else {
    doc.registerFont('body', 'Helvetica');
    doc.registerFont('bold', 'Helvetica-Bold');
  }
}

// Paint the whole current page black. Called once for page 1 and again right
// after every doc.addPage(), always BEFORE any content lands on that page.
function paintBackground(doc) {
  doc.save().rect(0, 0, doc.page.width, doc.page.height).fill(C.bg).restore();
}

// Brand hero at the top of page 1: the skull crest centred with the club-name
// wordmark beneath it — reproducing the poster image directly on the invoice.
// If a full composite is dropped at assets/invoice-hero.png it is used instead.
// Returns the y just below the hero so the caller continues the layout there.
function heroHeader(doc) {
  let y = PAGE.top;
  if (fs.existsSync(HERO)) {
    try {
      doc.image(HERO, PAGE.left, y, { fit: [PAGE.width, 160], align: 'center' });
      return y + 160 + 12;
    } catch { /* fall through to the native crest */ }
  }
  if (fs.existsSync(LOGO)) {
    const LOGO_W = 80;
    try {
      doc.image(LOGO, (doc.page.width - LOGO_W) / 2, y, { width: LOGO_W });
      y += LOGO_W * (520 / 540); // keep the logo's native aspect ratio
    } catch { /* ignore a bad logo */ }
  }
  y += 8;
  doc.font('bold').fontSize(17).fillColor(C.text)
     .text('MONKEY MAYHEM FIGHT CLUB', PAGE.left, y, { width: PAGE.width, align: 'center', characterSpacing: 1.5 });
  y = doc.y + 10;
  doc.save().lineWidth(0.75).strokeColor(C.line).moveTo(PAGE.left, y).lineTo(PAGE.right, y).stroke().restore();
  return y + 16;
}

// A bordered "To"/"From" card with a coloured title + free-text body lines.
function card(doc, x, y, w, h, title, lines) {
  doc.save().lineWidth(1).strokeColor(C.line).rect(x, y, w, h).stroke().restore();
  doc.font('bold').fontSize(8).fillColor(C.red).text(title.toUpperCase(), x, y - 12);
  let cy = y + 10;
  doc.font('bold').fontSize(12).fillColor(C.text).text(lines[0] || '', x + 12, cy, { width: w - 24 });
  cy = doc.y + 4;
  doc.font('body').fontSize(9).fillColor(C.muted);
  for (const line of lines.slice(1)) {
    doc.text(line, x + 12, cy, { width: w - 24 });
    cy = doc.y + 2;
  }
}

// A label/value row with a hairline underneath; value right-aligned.
function kv(doc, x, y, w, label, value) {
  doc.font('body').fontSize(9).fillColor(C.muted).text(label, x, y, { width: w * 0.55 });
  doc.font('bold').fontSize(9).fillColor(C.text).text(value == null || value === '' ? '' : String(value), x, y, {
    width: w,
    align: 'right',
  });
  const ny = Math.max(doc.y, y + 12) + 6;
  doc.save().lineWidth(0.5).strokeColor(C.line).moveTo(x, ny - 3).lineTo(x + w, ny - 3).stroke().restore();
  return ny;
}

function tableHeader(doc, cols, y) {
  doc.save().fillColor(C.fill).rect(PAGE.left, y, PAGE.width, 20).fill().restore();
  doc.font('bold').fontSize(8).fillColor(C.text);
  let x = PAGE.left;
  for (const c of cols) {
    doc.text(c.label, x + 4, y + 6, { width: c.w - 8, align: c.align || 'left' });
    x += c.w;
  }
  return y + 20;
}

function tableRow(doc, cols, values, y) {
  const h = 20;
  let x = PAGE.left;
  doc.font('body').fontSize(8).fillColor(C.text);
  for (let i = 0; i < cols.length; i++) {
    doc.text(values[i] == null ? '' : String(values[i]), x + 4, y + 6, {
      width: cols[i].w - 8,
      align: cols[i].align || 'left',
      ellipsis: true,
      height: h - 8,
    });
    x += cols[i].w;
  }
  doc.save().lineWidth(0.5).strokeColor(C.line).moveTo(PAGE.left, y + h).lineTo(PAGE.right, y + h).stroke().restore();
  return y + h;
}

/**
 * Stream an invoice PDF to an Express response.
 * @param res Express response (headers set here)
 * @param data {
 *   invoiceNo, invoiceDate, member:{name,id,phone,gst},
 *   plan:{category,name,duration,dateRange,time,instructor,comment},
 *   amounts:{amount,registrationFee,discount,total,paid,balance},
 *   payments:[{reNo,date,subtotal,paidAmt,payMode,details,executive}]
 * }
 * @param filename download filename (already sanitized)
 */
export function streamInvoice(res, data, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  // If anything goes wrong mid-stream the headers are already flushed, so we
  // can't send a JSON error — tear the socket down instead of hanging.
  doc.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
  doc.pipe(res);

  try {
    render(doc, data);
  } catch (err) {
    try { res.destroy(err); } catch { /* already gone */ }
    throw err;
  }
}

function render(doc, data) {
  fonts(doc);
  paintBackground(doc);                 // page 1 (each overflow page repaints too)

  // Brand hero (skull crest + wordmark), then the INVOICE title.
  let y = heroHeader(doc);
  doc.font('bold').fontSize(20).fillColor(C.red)
     .text('INVOICE', PAGE.left, y, { align: 'center', width: PAGE.width });

  // Invoice no / date
  y = doc.y + 10;
  doc.font('bold').fontSize(9).fillColor(C.text).text(`Invoice No - ${data.invoiceNo ?? ''}`, PAGE.left, y);
  doc.font('body').fontSize(9).fillColor(C.muted).text(`Date - ${data.invoiceDate || ''}`, PAGE.left, doc.y + 2);

  // To / From cards
  y = doc.y + 18;
  const cardW = (PAGE.width - 20) / 2;
  const cardH = 92;
  card(doc, PAGE.left, y, cardW, cardH, 'To', [
    data.member.name || '',
    `ID - ${data.member.id ?? ''}`,
    data.member.phone || '',
    `GST - ${data.member.gst || 'NA'}`,
  ]);
  card(doc, PAGE.left + cardW + 20, y, cardW, cardH, 'From', [
    business.name,
    business.address,
    `${business.phone} | ${business.email}`,
  ]);

  // Key/value columns
  y += cardH + 24;
  const colW = (PAGE.width - 24) / 2;
  const rightX = PAGE.left + colW + 24;
  let ly = y;
  ly = kv(doc, PAGE.left, ly, colW, 'Package:', data.plan.category);
  ly = kv(doc, PAGE.left, ly, colW, 'Package Name:', data.plan.name);
  ly = kv(doc, PAGE.left, ly, colW, 'Duration/Session:', data.plan.duration);
  ly = kv(doc, PAGE.left, ly, colW, 'Date:', data.plan.dateRange);
  ly = kv(doc, PAGE.left, ly, colW, 'Time:', data.plan.time);
  ly = kv(doc, PAGE.left, ly, colW, 'Instructor:', data.plan.instructor);
  ly = kv(doc, PAGE.left, ly, colW, 'Comment:', data.plan.comment);

  let ry = y;
  ry = kv(doc, rightX, ry, colW, 'Amount:', money(data.amounts.amount));
  ry = kv(doc, rightX, ry, colW, 'Registration Fee:', money(data.amounts.registrationFee));
  ry = kv(doc, rightX, ry, colW, 'Discount:', money(data.amounts.discount));
  ry = kv(doc, rightX, ry, colW, 'Total Amount:', money(data.amounts.total));
  ry = kv(doc, rightX, ry, colW, 'Paid Amount:', money(data.amounts.paid));
  ry = kv(doc, rightX, ry, colW, 'Remaining Balance:', money(data.amounts.balance));

  // Payment Transaction table
  y = Math.max(ly, ry) + 16;
  doc.font('bold').fontSize(9).fillColor(C.accent).text('Payment Transaction', PAGE.left, y);
  y += 16;
  const cols = [
    { label: 'Re No', w: 45 },
    { label: 'Date', w: 70 },
    { label: 'Subtotal', w: 70, align: 'right' },
    { label: 'Paid Amt', w: 70, align: 'right' },
    { label: 'Pay Mode', w: 70 },
    { label: 'Details', w: 110 },
    { label: 'Executive', w: 80 },
  ];
  y = tableHeader(doc, cols, y);
  if (!data.payments.length) {
    doc.font('body').fontSize(8).fillColor(C.muted).text('No payments recorded.', PAGE.left + 4, y + 6);
    y += 20;
  }
  for (const p of data.payments) {
    if (y + 20 > PAGE.bottom) {
      doc.addPage();
      paintBackground(doc);           // black the fresh page before any content
      y = PAGE.top;
      y = tableHeader(doc, cols, y);
    }
    y = tableRow(doc, cols, [p.reNo, p.date, money(p.subtotal), money(p.paidAmt), p.payMode, p.details, p.executive], y);
  }

  // Terms
  y += 20;
  doc.font('bold').fontSize(9).fillColor(C.accent).text('Terms And Conditions :', PAGE.left, y);
  doc.font('body').fontSize(8).fillColor(C.muted).text(TERMS, PAGE.left, doc.y + 4, { width: PAGE.width });

  // Footer thank-you heading — pinned toward the page bottom, but pushed down
  // if the content above already reaches that far (onto a new page if needed).
  let footerY = Math.max(doc.y + 28, 760);
  if (footerY > PAGE.bottom - 30) { doc.addPage(); paintBackground(doc); footerY = PAGE.top + 20; }
  doc.save().lineWidth(0.5).strokeColor(C.line).moveTo(PAGE.left, footerY).lineTo(PAGE.right, footerY).stroke().restore();
  doc.font('bold').fontSize(14).fillColor(C.red).text('Thank you for making me Rich!!!', PAGE.left, footerY + 12, { align: 'center', width: PAGE.width });

  doc.end();
}
