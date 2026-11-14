const STORE_ADDRESS = process.env.STORE_ADDRESS || 'Shop 32A, Akure Shopping Mall (Justrite), Akure, Ondo State';

function checkStoreHours(db, rawInput = {}) {
  const dayInput = (rawInput && typeof rawInput.day === 'string' && rawInput.day.trim()) || '';

  let targetDay = dayInput;
  if (!targetDay || targetDay.toLowerCase() === 'today') {
    // Current day in West Africa Time (WAT: UTC+1)
    const watDate = new Date(Date.now() + 60 * 60 * 1000);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    targetDay = days[watDate.getUTCDay()];
  } else if (targetDay.toLowerCase() === 'tomorrow') {
    const watDate = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    targetDay = days[watDate.getUTCDay()];
  }

  const row = db.prepare(`
    SELECT day_of_week, is_open, open_time, close_time, notes
    FROM store_hours
    WHERE day_of_week = ? COLLATE NOCASE
  `).get(targetDay);

  if (!row) {
    return {
      ok: false,
      error: `No store hours schedule found for day: ${targetDay}`,
      day_requested: targetDay
    };
  }

  return {
    ok: true,
    day: row.day_of_week,
    is_open: Boolean(row.is_open),
    open_time: row.open_time,
    close_time: row.close_time,
    notes: row.notes,
    store_address: STORE_ADDRESS
  };
}

module.exports = { checkStoreHours };
