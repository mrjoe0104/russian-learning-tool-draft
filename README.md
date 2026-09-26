# 러시아어 학습 도구 V1.9

온라인 배포용 버전입니다. 브라우저에서 Node.js를 설치하지 않아도 사용할 수 있도록 Node 서버를 웹 호스팅에 배포하는 구조입니다.

## 로컬 테스트

```bash
npm test
npm start
```

브라우저: http://localhost:3000

## Render 배포

1. 이 폴더를 GitHub 저장소에 올립니다.
2. Render에서 **New → Web Service**를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Health Check Path: `/api/health`
7. 배포가 끝나면 Render가 제공하는 `onrender.com` 주소로 접속합니다.

`server.js`는 Render가 요구하는 `PORT` 환경변수와 `0.0.0.0` 바인딩을 사용합니다.
