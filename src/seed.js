const products = [
  {
    id: 'rose-massager-01',
    name: 'Rose Personal Massager',
    category: 'personal massagers',
    description: 'Rechargeable silicone personal massager. Fixture listing; verify product details before use.',
    usage_summary: 'Follow the instructions supplied with the product. This listing is not medical advice.',
    retail_price: 38000,
    min_price: 35000,
    stock_quantity: 5,
    image_url: null
  },
  {
    id: 'pocket-massager-02',
    name: 'Pocket Personal Massager',
    category: 'personal massagers',
    description: 'Compact rechargeable personal massager. Fixture listing; verify product details before use.',
    usage_summary: 'Follow the instructions supplied with the product. This listing is not medical advice.',
    retail_price: 22000,
    min_price: 22000,
    stock_quantity: 8,
    image_url: null
  },
  {
    id: 'wellness-gel-03',
    name: 'Water-Based Personal Gel',
    category: 'personal care',
    description: 'Water-based personal care gel. Fixture listing; check the package label for ingredients.',
    usage_summary: 'Use only as directed on the package. Stop use if irritation occurs.',
    retail_price: 6500,
    min_price: 6000,
    stock_quantity: 12,
    image_url: null
  },
  {
    id: 'couples-cards-04',
    name: 'Couples Conversation Cards',
    category: 'games',
    description: 'A boxed set of conversation prompts for adults.',
    usage_summary: 'Take turns choosing and answering a card.',
    retail_price: 12000,
    min_price: 11000,
    stock_quantity: 3,
    image_url: null
  },
  {
    id: 'silicone-accessory-05',
    name: 'Silicone Wellness Accessory',
    category: 'accessories',
    description: 'Body-safe silicone accessory. Fixture listing; verify product details before use.',
    usage_summary: 'Follow the instructions supplied with the product.',
    retail_price: 18000,
    min_price: 17000,
    stock_quantity: 0,
    image_url: null
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

function seedTemporaryData(db) {
  const insertProduct = db.prepare(`
    INSERT OR IGNORE INTO products
      (id, name, category, description, usage_summary, retail_price, min_price, stock_quantity, image_url)
    VALUES
      (@id, @name, @category, @description, @usage_summary, @retail_price, @min_price, @stock_quantity, @image_url)
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

  const seed = db.transaction(() => {
    products.forEach(product => insertProduct.run(product));
    deliveryZones.forEach(zone => insertDelivery.run(zone));
  });

  seed();
}

module.exports = { deliveryZones, products, seedTemporaryData };