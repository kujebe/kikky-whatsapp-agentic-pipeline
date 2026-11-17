const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

const CONFIG_PATH = path.resolve(__dirname, '..', 'store.config.json');

let storeConfig = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    storeConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[CONFIG] Error reading store.config.json: ${err.message}. Using default values.`);
    storeConfig = {};
  }
}

const storeName = process.env.STORE_NAME || storeConfig.storeName || 'Kikky Luxury Femcare';
const storeDescriptor = process.env.PAYSTACK_STATEMENT_DESCRIPTOR || storeConfig.descriptor || 'KLF Luxury Care';
const currencySymbol = process.env.CURRENCY_SYMBOL || storeConfig.currencySymbol || '₦';

const physicalLocation = {
  name: storeConfig.physicalLocation?.name || 'Shop 32A Akure Shopping Mall (Justrite)',
  address: process.env.STORE_ADDRESS || storeConfig.physicalLocation?.address || 'Shop 32A Akure Shopping Mall (Justrite), Akure, Ondo State',
  city: storeConfig.physicalLocation?.city || 'Akure',
  state: storeConfig.physicalLocation?.state || 'Ondo State'
};

const bankAccount = {
  bankName: process.env.BANK_NAME || storeConfig.bankAccount?.bankName || 'Moniepoint MFB',
  accountNumber: process.env.ACCOUNT_NUMBER || storeConfig.bankAccount?.accountNumber || '5140099034',
  accountName: process.env.ACCOUNT_NAME || storeConfig.bankAccount?.accountName || 'Ajayi Kikelomo Oluwatosin'
};

const fallbackEmailDomain = process.env.FALLBACK_EMAIL_DOMAIN || storeConfig.fallbackEmailDomain || 'kikkycare.ng';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const paystackWebhookPort = parseInt(process.env.PAYSTACK_WEBHOOK_PORT || '3001', 10);
const paystackCallbackUrl = process.env.PAYSTACK_CALLBACK_URL || '';

const bankDetailsString = process.env.STORE_PAYMENT_ACCOUNT || `${bankAccount.accountNumber} ${bankAccount.bankName} ${bankAccount.accountName}`;

function formatBankDetails() {
  return `Bank: ${bankAccount.bankName}\nAccount Name: ${bankAccount.accountName}\nAccount Number: ${bankAccount.accountNumber}`;
}

module.exports = {
  storeName,
  storeDescriptor,
  currencySymbol,
  physicalLocation,
  bankAccount,
  bankDetailsString,
  fallbackEmailDomain,
  paystackSecretKey,
  paystackWebhookPort,
  paystackCallbackUrl,
  formatBankDetails
};
