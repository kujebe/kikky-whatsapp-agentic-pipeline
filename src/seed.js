// search_tags bridges the gap between bank/compliance-friendly catalog names
// Bridges formal catalog names and raw customer vocabulary on WhatsApp (slang,
// euphemisms, and common mobile typos like "vibrator", "vibrater", "lube", "dildo").
// This column is indexed in FTS5 but never exposed to customers in search results.
const products = [
  {
    id: 'rose-massager-01',
    name: 'Rose Personal Massager',
    category: 'personal massagers',
    description: 'Rechargeable silicone clitoral suction massager. Verified boutique item.',
    usage_summary: 'Rechargeable via USB. Wash with warm water and mild soap.',
    retail_price: 30000,
    min_price: 30000,
    stock_quantity: 5,
    image_url: null,
    search_tags: 'vibrator vibrater vibrators vibraters clitoral suction rose toy toys adult flower 🌹'
  },
  {
    id: 'pocket-massager-02',
    name: 'Compact Bullet Massager',
    category: 'personal massagers',
    description: 'Compact rechargeable bullet massager. Verified boutique item.',
    usage_summary: 'Multi-speed vibration. Clean before and after use.',
    retail_price: 17000,
    min_price: 17000,
    stock_quantity: 8,
    image_url: null,
    search_tags: 'vibrator vibrater vibrators vibraters bullet mini pocket small toy toys adult'
  },
  {
    id: 'wellness-gel-03',
    name: 'Water-Based Personal Gel',
    category: 'personal care',
    description: 'Body-safe water-based personal care intimate gel.',
    usage_summary: 'Apply desired amount to intimate areas. Latex friendly. Easy rinse.',
    retail_price: 5000,
    min_price: 5000,
    stock_quantity: 15,
    image_url: null,
    search_tags: 'lube lubes lubricant lubricants gel gels moisture personal intimate wet'
  },
  {
    id: 'couples-cards-04',
    name: 'Couples Conversation Cards',
    category: 'games',
    description: 'A boxed intimacy and romance card prompt game for couples.',
    usage_summary: 'Take turns choosing and answering romantic/intimate prompt cards.',
    retail_price: 10000,
    min_price: 10000,
    stock_quantity: 4,
    image_url: null,
    search_tags: 'game games card cards romance date night couples question questions conversation adult game'
  },
  {
    id: 'silicone-accessory-05',
    name: 'Classic Manual Silicone Accessory',
    category: 'accessories',
    description: 'Body-safe manual silicone accessory. 5 to 6 inch format.',
    usage_summary: 'Manual use. Wash thoroughly with soap and warm water before and after use.',
    retail_price: 22500,
    min_price: 22500,
    stock_quantity: 0,
    image_url: null,
    search_tags: 'dildo dildos dildoo silicone strap rubber 5inch 5inches 6inch 6inches manual'
  },
  {
    id: 'vibrating-accessory-06',
    name: 'Vibrating Silicone Wellness Accessory',
    category: 'personal massagers',
    description: 'Motorized vibrating silicone wellness accessory with multi-speed motion.',
    usage_summary: 'USB rechargeable motorized vibration modes. Clean thoroughly after use.',
    retail_price: 46000,
    min_price: 46000,
    stock_quantity: 2,
    image_url: null,
    search_tags: 'dildo dildos vibrating moving motorized silicone 8inch 8inches'
  },
  {
    id: 'wand-massager-07',
    name: 'Long Personal Massager',
    category: 'personal massagers',
    description: 'Extended wand personal massager with multi-pattern vibrations.',
    usage_summary: 'Rechargeable body wand. Safe silicone head.',
    retail_price: 25000,
    min_price: 25000,
    stock_quantity: 3,
    image_url: null,
    search_tags: 'long vibrator purple massager wand toy adult'
  },
  {
    id: 'dual-massager-08',
    name: 'Dual Stimulation 2-in-1 Massager',
    category: 'personal massagers',
    description: 'Dual-stimulation rechargeable wellness massager.',
    usage_summary: 'Dual motors for independent or simultaneous stimulation.',
    retail_price: 39000,
    min_price: 39000,
    stock_quantity: 2,
    image_url: null,
    search_tags: '2in1 3in1 dual rabbit stimulation toy adult'
  },
  {
    id: 'bdsm-mini-kit-09',
    name: 'Mini Restraint & Sensory Kit',
    category: 'accessories',
    description: 'Sensory restraint kit containing eye mask and plush handcuffs.',
    usage_summary: 'For adult sensory and couple play.',
    retail_price: 18000,
    min_price: 18000,
    stock_quantity: 2,
    image_url: null,
    search_tags: 'bdsm mini kit handcuffs mask pink bondage toy restraint'
  },
  {
    id: 'bdsm-full-kit-10',
    name: 'Full BDSM Intimacy Restraint Set',
    category: 'accessories',
    description: 'Complete adult intimacy restraint set with eye mask, collar, handcuffs, and plug.',
    usage_summary: 'Adult couples restraint and sensory play set.',
    retail_price: 35000,
    min_price: 35000,
    stock_quantity: 1,
    image_url: null,
    search_tags: 'full bdsm kit bondage anal plug 2 masks restraints collar red black'
  },
  {
    id: 'body-firming-oil-11',
    name: 'Firming Massage Oil & Powder Set',
    category: 'personal care',
    description: 'Topical firming herbal massage oil and powder set for breast and hip massage.',
    usage_summary: 'Topical external massage only. Strictly NOT for oral ingestion.',
    retail_price: 17000,
    min_price: 17000,
    stock_quantity: 8,
    image_url: null,
    search_tags: 'breast boost butt lift massage oil powder firming topical herbal'
  }
];

const deliveryZones = [
  { state: 'Ondo', city: null, fee: 2500, estimated_days: '1-3' },
  { state: 'Ondo', city: 'Akure', fee: 1500, estimated_days: '1-2' },
  { state: 'Lagos', city: null, fee: 6000, estimated_days: '2-5' },
  { state: 'Lagos', city: 'Lagos', fee: 5000, estimated_days: '2-4' },
  { state: 'FCT', city: null, fee: 9000, estimated_days: '3-6' },
  { state: 'FCT', city: 'Abuja', fee: 7000, estimated_days: '3-5' },
  { state: 'Abuja', city: null, fee: 8500, estimated_days: '3-6' }
];

const STORE_WALK_IN_NOTE = `Walk-in open at ${process.env.STORE_ADDRESS || 'Shop 32A Akure Mall (Justrite)'}`;

const storeHours = [
  { day_of_week: 'Monday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Tuesday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Wednesday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Thursday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Friday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Saturday', is_open: 1, open_time: '09:00', close_time: '19:00', notes: STORE_WALK_IN_NOTE },
  { day_of_week: 'Sunday', is_open: 0, open_time: null, close_time: null, notes: 'Closed on Sundays. Park pickups available by arrangement.' }
];

function seedTemporaryData(db) {
  const insertProduct = db.prepare(`
    INSERT INTO products
      (id, name, category, description, usage_summary, retail_price, min_price, stock_quantity, image_url, search_tags)
    VALUES
      (@id, @name, @category, @description, @usage_summary, @retail_price, @min_price, @stock_quantity, @image_url, @search_tags)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      description = excluded.description,
      usage_summary = excluded.usage_summary,
      retail_price = excluded.retail_price,
      min_price = excluded.min_price,
      stock_quantity = excluded.stock_quantity,
      search_tags = excluded.search_tags
  `);

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (state, city, fee, estimated_days)
    SELECT @state, @city, @fee, @estimated_days
    WHERE NOT EXISTS (
      SELECT 1 FROM deliveries
      WHERE state = @state COLLATE NOCASE
        AND ((city IS NULL AND @city IS NULL) OR city = @city COLLATE NOCASE)
    )
  `);

  const insertStoreHour = db.prepare(`
    INSERT INTO store_hours (day_of_week, is_open, open_time, close_time, notes)
    VALUES (@day_of_week, @is_open, @open_time, @close_time, @notes)
    ON CONFLICT(day_of_week) DO UPDATE SET
      is_open = excluded.is_open,
      open_time = excluded.open_time,
      close_time = excluded.close_time,
      notes = excluded.notes
  `);

  const seed = db.transaction(() => {
    products.forEach(product => insertProduct.run(product));
    deliveryZones.forEach(zone => insertDelivery.run(zone));
    storeHours.forEach(hour => insertStoreHour.run(hour));
  });

  seed();
}

module.exports = { deliveryZones, products, storeHours, seedTemporaryData };
