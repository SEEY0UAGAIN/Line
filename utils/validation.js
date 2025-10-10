function isValidIdCard(idCard) {
  return /^\d{13}$/.test(idCard);
}

module.exports = { isValidIdCard };
