
const http = require('http');

const data = JSON.stringify({
    query: "분석 불러오기 시 프로젝트 결과에서 확인 불가 문제가 발생했던 이력들을 살피고 각 이력들의 문제 원인과 출처들을 각각 한줄로 정리해줘",
    stream: false,
    // Add a common project ID if known, otherwise hope the backend handles it or we find one
    // project_id: "...", 
});

const options = {
    hostname: 'localhost',
    port: 8000,
    path: '/api/v1/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
        console.log(body);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.write(data);
req.end();
