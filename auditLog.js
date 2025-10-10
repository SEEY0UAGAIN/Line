function maskIdCard(idCard) {
  if (!idCard || idCard.length !== 13) return '*************';
  return '***********' + idCard.slice(-2);
}

function logEvent(eventType, details) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${eventType}:`, {
    ...details,
    id_card: maskIdCard(details.id_card)
  });
  return Promise.resolve(); // ให้เป็น async function แบบ Promise
}

module.exports = { logEvent, maskIdCard };
