const resultElem = document.getElementById('qr-result');
const debugBox = document.getElementById('debug-box');

// 🔍 ฟังก์ชันแสดงข้อความ debug
function debugLog(label, data) {
  const time = new Date().toLocaleTimeString();
  debugBox.innerText += `\n[${time}] ${label}: ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`;
}

function startScanner() {
  const html5QrCode = new Html5Qrcode("preview");

  debugLog("Scanner", "Starting camera...");

  html5QrCode.start(
    { facingMode: "environment" },
    {
      fps: 10,
      qrbox: 350
    },
    qrCodeMessage => {
      debugLog("QR Detected", qrCodeMessage);
      resultElem.innerText = `QR Code: ${qrCodeMessage}`;
      html5QrCode.stop();
      processQRCode(qrCodeMessage);
    },
    errorMessage => {
      // debugLog("Scan error", errorMessage);
    }
  ).catch(err => {
    debugLog("Camera error", err);
    console.error(err);
  });
}

async function processQRCode(token) {
  debugLog("Process", `Decoding token...`);

  let decoded = null;
  try {
    decoded = jwt_decode(token);   // ✅ ถอดรหัส JWT
    debugLog("Decoded QR", decoded);
  } catch (err) {
    resultElem.innerText = "❌ ไม่สามารถถอดรหัส QR ได้";
    debugLog("Decode Error", err.message);
    return;
  }

  // เตรียมข้อมูลส่งเข้า API
  const payload = {
    vn: decoded.cid || decoded.jti || "UNKNOWN",     // ✅ ใช้ cid เป็น vn
    queue_type: "Pharmacy",
    patient_name: decoded.name || "ไม่ระบุชื่อ",
    line_user_id: decoded.line_user_id || "unknown"
  };

  debugLog("Process", "Sending payload: " + JSON.stringify(payload, null, 2));

  try {
    const res = await fetch('/queue/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    debugLog("Raw Response", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      resultElem.innerText = "Server ตอบกลับไม่ใช่ JSON";
      debugLog("Parse Error", text);
      return;
    }

    debugLog("Parsed JSON", data);

    if (data.success) {
      resultElem.innerText = `ลงทะเบียนเรียบร้อย! คิวของคุณคือ ${data.queue.queue_no}`;
      debugLog("Result", "Success");
    } else if (data.message) {
      resultElem.innerText = `เกิดข้อผิดพลาด: ${data.message}`;
      debugLog("Result", "Error: " + data.message);
    } else if (data.error) {
      resultElem.innerText = `เกิดข้อผิดพลาด: ${data.error}`;
      debugLog("Result", "Error: " + data.error);
    } else {
      resultElem.innerText = "เกิดข้อผิดพลาด: ไม่พบข้อมูล success/error จากเซิร์ฟเวอร์";
      debugLog("Result", "Unexpected response structure");
    }
  } catch (err) {
    resultElem.innerText = `Error: ${err.message}`;
    debugLog("Fetch Error", err.message);
  }
}


startScanner();
