import fs from 'fs';
const SCRATCH = '/private/tmp/claude-501/-Users-harshverma-Downloads-files--3-/2a86eff6-f7d7-4bf9-9d1f-bfe21f6fcaf8/scratchpad';
const OUT = `${SCRATCH}/test-invoice.pdf`;

const out = fs.createWriteStream(OUT);
out.setHeader = () => {}; // mock express res.setHeader

const data = {
  invoiceNo: 60, invoiceDate: '10-06-2026',
  member: { name: 'Ethan Dilma', id: 32, phone: '919820155946', gst: 'NA' },
  plan: { category: 'MMA', name: 'Monthly Package', duration: '31 / 31', dateRange: '10-06-2026 - 10-07-2026', time: '', instructor: '', comment: '' },
  amounts: { amount: 3500, registrationFee: 0, discount: 0, total: 3500, paid: 0, balance: 3500 },
  payments: [{ reNo: 61, date: '10-06-2026', subtotal: 0, paidAmt: 0, payMode: 'Cash', details: 'partial', executive: 'Nithesh Chandra Kumar' }],
};

const { streamInvoice } = await import('/Users/harshverma/Downloads/files (3)/monkey-mayhem-backend/services/invoicePdf.js');
streamInvoice(out, data, 'test.pdf');

out.on('finish', () => {
  const buf = fs.readFileSync(OUT);
  console.log('PDF header :', JSON.stringify(buf.slice(0, 5).toString()));
  console.log('PDF bytes  :', buf.length);
});
out.on('error', (e) => { console.error('stream error:', e.message); process.exit(1); });

const ExcelJS = (await import('exceljs')).default;
console.log('exceljs    :', ExcelJS ? 'ok' : 'missing');
