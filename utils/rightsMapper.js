const RIGHT_GROUP_MAP = {
  'WI': [
    '1010', '1011', '1012', '1013', '1014', '1015', '1101', '11011', '11012', '1102', 
    '11021', '11022', '11023', '11024', '11025', '1106', '11061', '11062', '11063', '1107', 
    '1109', '1110', '11101', '1115', '11151', '1142', '11421', '1143', '1144', '1145', 
    '1146', '11461', '11462', '1147', '4103', '4110', '4111', '4112', '4113', '4114', 
    '4115', '4116', '4117', '4118', '4119', '4120', '4121', '4122', '4123', '4124', 
    '4125', '4126', '4127', '5100', '5101', '5102', '5103', '5104', '5105', '5106', 
    '5107', '5108', '5200', 'DT101', 'DT110'
  ],
  'SC+': [
    'CO01', 'CO02', 'CO03', 'CO04', 'SC02', 'SC03', 'SC031', 'SC04', 'SC05', 'SC06'
  ],
  'Inter': [
    '1129', '11291', '11292', '11293', '1130'
  ],
  'SC': [
    '2100', '21001', '21002', '21003', '21004', '21005', '2105', '21051', '2106', 
    '2108', '21081', '2109', '2205', '2206', '2207', '2208', '2209', '2210', '2211', 
    '2212', '2213', '2214', '2215', '2216', '2217', '3104', '3105', '4100', 'DT210'
  ],
  'KPS': [
    '11024', '11025', '1015'
  ]
};

function mapRightCodeToGroup(rightCode) {
  if (!rightCode) return 'อื่นๆ';
  
  const code = rightCode.toString().trim();
  
  // หาว่ารหัสนี้อยู่ในกลุ่มไหน
  for (const [groupName, codes] of Object.entries(RIGHT_GROUP_MAP)) {
    if (codes.includes(code)) {
      return groupName;
    }
  }
  
  return 'อื่นๆ';
}

function mapRightCodesToGroups(rightCodes) {
  if (!rightCodes || rightCodes.length === 0) return [];
  
  const groups = rightCodes.map(code => mapRightCodeToGroup(code));
  
  // ลบกลุ่มที่ซ้ำกัน
  return [...new Set(groups)];
}

function formatRightsMessage(rightCodes) {
  if (!rightCodes || rightCodes.length === 0) {
    return '⚠️ คุณยังไม่มีสิทธิ์ใช้งาน';
  }
  
  const groups = mapRightCodesToGroups(rightCodes);
  const groupText = groups.join(', ');
  
  // เพิ่ม emoji ตามกลุ่ม
  const emoji = getEmojiForGroups(groups);
  
  return `${emoji} สิทธิ์ของคุณ: ${groupText}`;
}

function getEmojiForGroups(groups) {
  if (groups.includes('WI') || groups.includes('Inter')) return '✨';
  if (groups.includes('SC+')) return '⭐';
  if (groups.includes('KPS')) return '🏥';
  if (groups.includes('SC')) return '🔑';
  return '📋';
}

module.exports = {
  mapRightCodeToGroup,
  mapRightCodesToGroups,
  formatRightsMessage,
  RIGHT_GROUP_MAP
};