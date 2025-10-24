function maskIdCard(idCard) {
  if (!idCard || idCard.length !== 13) return '*************';
  return idCard.slice(0, 3) + '******' + idCard.slice(-4);
}

async function logEvent(eventType, details = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${eventType}:`, {
    ...details,
    id_card: maskIdCard(details.id_card)
  });
}

module.exports = { logEvent, maskIdCard };
