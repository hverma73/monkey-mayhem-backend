// Gym ("From") details printed on every invoice. Defaults match the sample
// invoice; override any of them with BIZ_* environment variables (no secrets
// here — these are public business details).
export const business = {
  name:       process.env.BIZ_NAME    || 'Monkey Mayhem Fight Club',
  address:    process.env.BIZ_ADDRESS ||
    'Monkey Mayhem Fight Club, 3rd Floor, Nalapad Building, next to Kadri Dwara, ' +
    'Mallikatte Circle, Kadri, Mangalore 575002',
  phone:      process.env.BIZ_PHONE   || '919742503202',
  email:      process.env.BIZ_EMAIL   || 'monkeymayhemfightclub@gmail.com',
  gst:        process.env.BIZ_GST     || 'NA',
  // The "Package" category line on the invoice (the gym's discipline).
  discipline: process.env.BIZ_DISCIPLINE || 'MMA',
  // Optional logo: drop a PNG/JPG at assets/logo.png to print it top-right.
  // (PDFKit cannot embed the app's SVG logo.)
};

export const TERMS =
  process.env.BIZ_TERMS ||
  'Fees once paid are non-refundable. Please retain this ' +
  'invoice as proof of payment. Membership is subject to the club rules.';
