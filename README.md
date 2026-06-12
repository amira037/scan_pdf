# PDF 양면 스캔 합치기 · 보정 (v4)

브라우저에서만 동작하는 PDF 유틸리티. 서버 업로드 없음.
양면 스캔 재조합 / 순서대로 합치기 / 스캔 보정(기울기·색상·용량).

## 파일 구조
- `index.html` — UI 골격
- `styles.css` — 스타일(다크 테마)
- `app.js` — UI·상태·합치기·미리보기·라이트박스, 보정은 워커에 위임
- `correction-worker.js` — 보정 픽셀 파이프라인(기울기·적응형 이진화·대비·인코딩) + 1비트 PNG 인코더

외부 라이브러리는 CDN으로 로드(pdf.js, pdf-lib, pako) — 빌드 단계 없음.

## 로컬 실행
워커는 같은 출처에서 로드돼야 해서 `file://` 직접 열기는 막힐 수 있음. 정적 서버로 띄울 것:

    python3 -m http.server 8000
    # 또는
    npx serve

브라우저에서 http://localhost:8000

## 배포 (GitHub → Cloudflare Pages)
1. 이 폴더를 그대로 GitHub 레포에 push
2. Cloudflare Pages에서 레포 연결
3. 빌드 명령: 없음 / 출력 디렉터리: 루트(`/`)
정적 파일만이라 그대로 서빙됨.

## v4에서 바뀐 점
- 보정 픽셀 연산을 Web Worker로 이전 → 처리 중에도 UI가 멈추지 않음
- 흑백 모드 출력을 진짜 1비트 PNG로 인코딩 → RGBA 대비 약 4배 작음(문제집 스캔에 유리)
- 보정 켜면 "대표 페이지 미리보기 → 전체 적용" 확인 단계 추가(잘못된 설정을 전체 처리 전에 잡음)
- 진행률(페이지 단위) + 취소 버튼

## 브라우저 테스트 권장 항목
아래는 브라우저 없이 검증 불가 — 실제로 한 번 돌려볼 것:
- 워커 로드/메시지 왕복(OffscreenCanvas, createImageBitmap, pako CDN)
- 다양한 DPI·색상 모드에서 보정 결과/용량
- 대용량(수십 페이지) 문서에서 반응성·메모리

## 다국어 / 검색 노출 (v4.1)
파일 구조:
- `index.html` — 한국어 랜딩 + 도구 (루트 `/`)
- `en/index.html` — 영문 랜딩 + 도구 (`/en/`)
- `styles.css` `app.js` `correction-worker.js` — 두 언어 공유 (절대경로 `/...`로 로드)

각 페이지에 포함된 것: SEO 제목·메타설명, hreflang(ko/en/x-default), canonical,
OpenGraph/Twitter 카드, 소개·사용법·FAQ 본문(정적), JSON-LD(WebApplication + FAQPage).

### 배포 전 반드시 할 일
1. 두 HTML의 `YOUR-DOMAIN.example`을 실제 도메인으로 일괄 치환
   (canonical, hreflang, og:url 들)
2. 네이버 웹마스터도구 + 구글 서치콘솔에 사이트 등록, 사이트맵 제출
3. (권장) `og:image` 대표 이미지 추가

> 자산을 절대경로(`/app.js` 등)로 두었으므로 **루트 도메인 서빙**을 전제로 합니다.
> 서브경로에 올릴 경우 경로를 상대경로로 바꿔야 합니다.
