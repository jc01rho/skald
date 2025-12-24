
const http = require('http');

console.log("Starting API call to Skald...");

const data = JSON.stringify({
    query: "분석 불러오기 시 프로젝트 결과에서 확인 불가 문제가 발생했던 이력들을 살피고 각 이력들의 문제 원인과 출처들을 각각 한줄로 정리해줘",
    stream: false,
    project_id: "83dabf13-0c3e-41f0-8f6b-75a817cd1e25"
});

const options = {
    hostname: 'localhost',
    port: 8000,
    path: '/api/v1/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer sk_proj_53810647708a05e33cf23649e53d4aa42d3aca6b',
        'Content-Length': Buffer.byteLength(data)
    }
};

const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
        console.log("Response received:");
        try {
            const parsed = JSON.parse(body);
            console.log(JSON.stringify(parsed, null, 2));
        } catch (e) {
            console.log(body);
        }
    });
});

req.on('error', (e) => {
    console.error(`Error: ${e.message}`);
});

req.write(data);
req.end();
console.log("Request sent, waiting for response...");
