const videoElem = document.getElementById('preview');
const resultElem = document.getElementById('qr-result');

function startScanner() {
    const html5QrCode = new Html5Qrcode("preview");

    html5QrCode.start(
        { facingMode: "environment" },
        {
            fps: 10,
            qrbox: 250
        },
        qrCodeMessage => {
            resultElem.innerText = `QR Code: ${qrCodeMessage}`;
            html5QrCode.stop();
            processQRCode(qrCodeMessage);
        },
        errorMessage => {
            // console.log(errorMessage);
        }
    ).catch(err => console.error(err));
}

async function processQRCode(token) {
    try {
        const res = await fetch('/queue/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                visit_id: token,
                patient_name: "ผู้ป่วยตัวอย่าง",
                station: "Pharmacy",
                line_user_id: "Uxxxxxxxxxxxx"
            })
        });
        const data = await res.json();
        if (data.success) {
            resultElem.innerText = `ลงทะเบียนเรียบร้อย! คิวของคุณคือ ${data.queue.queue_no}`;
        } else {
            resultElem.innerText = `เกิดข้อผิดพลาด: ${data.error}`;
        }
    } catch (err) {
        resultElem.innerText = `Error: ${err.message}`;
    }
}

startScanner();
