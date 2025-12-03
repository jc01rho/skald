# UI API 호출 문제 해결 - 변경 사항 요약

**날짜**: 2025-12-03  
**문제**: UI에서 API를 `http://localhost:8080/api/user/details/`로 요청하여 K8s 환경에서 실패

## 문제 원인

1. **Vite 빌드 제약**: 환경 변수가 빌드 시점에 코드에 삽입되므로 런타임 변경 불가
2. **브라우저 실행 환경**: UI는 브라우저에서 실행되므로 클러스터 내부 주소 접근 불가
3. **CORS 문제**: 다른 도메인/포트로 API 호출 시 CORS 위반 가능성

## 해결 방안: Nginx 프록시

UI 컨테이너의 Nginx가 `/api` 경로 요청을 클러스터 내부 `api-service:8080`으로 프록시

### 아키텍처 흐름

```
브라우저
  ↓ GET https://ui.skald.sparrow.local/api/user/details
  ↓
Ingress (NGINX)
  ↓ 라우팅: ui.skald.sparrow.local → ui-service:80
  ↓
UI Pod - Nginx
  ↓ 프록시: /api/* → http://api-service:8080/api/*
  ↓
API Service → API Pod
```

## 변경된 파일

### 1. 신규 파일

#### `/home/sparrow/git/skald/k8s/ui-nginx-configmap.yaml`
- **목적**: Nginx 설정을 ConfigMap으로 관리
- **핵심 내용**: `/api` 경로를 `http://api-service:8080/api/`로 프록시
- **배포 명령**:
  ```bash
  kubectl apply -f k8s/ui-nginx-configmap.yaml
  ```

#### `/home/sparrow/git/skald/k8s/ui-configmap.yaml`
- **목적**: 향후 런타임 환경 변수 주입 지원 (현재는 사용 안 함)
- **참고**: 필요시 사용할 수 있는 대안 솔루션

### 2. 수정된 파일

#### `/home/sparrow/git/skald/k8s/ui-deployment.yaml`
**변경 사항**:
1. **환경 변수 변경**:
   ```yaml
   # 이전: ConfigMap에서 API_URL 참조
   - name: VITE_API_URL
     valueFrom:
       configMapKeyRef:
         name: skald-config
         key: API_URL
   
   # 현재: 상대 경로로 변경
   - name: VITE_API_URL
     value: "/api"
   ```

2. **Nginx 설정 볼륨 마운트 추가**:
   ```yaml
   volumeMounts:
   - name: nginx-config
     mountPath: /etc/nginx/nginx.conf
     subPath: nginx.conf
     readOnly: true
   
   volumes:
   - name: nginx-config
     configMap:
       name: ui-nginx-config
   ```

**배포 명령**:
```bash
kubectl apply -f k8s/ui-deployment.yaml
kubectl rollout restart deployment/ui -n skald
```

#### `/home/sparrow/git/skald/k8s/api-url-architecture-design.md`
- **변경 사항**: 전체 아키텍처 문서를 Nginx 프록시 방식으로 업데이트
- **추가 내용**: 구현 단계, 검증 방법, 장점/고려사항 재작성

## 배포 순서

```bash
# 1. Nginx ConfigMap 생성
kubectl apply -f k8s/ui-nginx-configmap.yaml

# 2. UI Deployment 업데이트
kubectl apply -f k8s/ui-deployment.yaml
kubectl rollout restart deployment/ui -n skald

# 3. Pod 재시작 확인
kubectl get pods -n skald -l component=ui -w

# 4. 환경 변수 확인
kubectl exec -it deployment/ui -n skald -- env | grep VITE_API_URL
# 예상 출력: VITE_API_URL=/api

# 5. Nginx 설정 확인
kubectl exec -it deployment/ui -n skald -- cat /etc/nginx/nginx.conf | grep -A 10 "location /api"
```

## 배포 완료 상태 ✅

**날짜**: 2025-12-03  
**상태**: 성공

### 검증 결과

- ✅ UI Nginx ConfigMap 생성 완료
- ✅ UI Deployment 업데이트 완료
- ✅ UI Pods 2/2 Running
- ✅ 환경 변수 `VITE_API_URL=/api` 정상 설정
- ✅ Nginx 프록시 설정 정상 적용
- ✅ API 프록시 테스트 성공 (HTTP 200)
- ✅ `deploy.sh` 스크립트 업데이트 완료

### 테스트 결과

```bash
# UI Pod 내부에서 API 프록시 테스트
$ kubectl exec -it deployment/ui -n skald -- curl -s -o /dev/null -w "%{http_code}" http://localhost/api/health
200

# UI Pods 상태
$ kubectl get pods -n skald -l component=ui
NAME                  READY   STATUS    RESTARTS   AGE
ui-776f498fdb-k6pcz   1/1     Running   0          52s
ui-776f498fdb-qmxzd   1/1     Running   0          38s
```

## 검증 방법

### 1. Pod 내부에서 프록시 테스트
```bash
kubectl exec -it deployment/ui -n skald -- curl -v http://localhost:80/api/health
```

### 2. 포트 포워딩으로 로컬 테스트
```bash
kubectl port-forward -n skald svc/ui-service 8081:80
curl http://localhost:8081/api/health
```

### 3. 브라우저에서 확인
1. `https://ui.skald.sparrow.local` 접속
2. 개발자 도구(F12) → Network 탭
3. API 요청이 `/api/...` 경로로 발생하는지 확인
4. 응답 상태 코드 200 확인

## 장점

✅ **동일 오리진**: UI와 API가 같은 도메인에서 제공되어 CORS 문제 해결  
✅ **Vite 제약 극복**: 빌드 시점 환경 변수가 아닌 Nginx 프록시 사용  
✅ **브라우저 호환**: 클러스터 내부 주소 접근 불필요  
✅ **보안 강화**: API 서비스가 클러스터 내부에만 노출  
✅ **유지보수성**: Nginx 설정만 변경하면 됨 (프론트엔드 재빌드 불필요)  
✅ **성능**: HTTP/2 연결 재사용 가능

## 주의사항

⚠️ **readOnlyRootFilesystem**: UI Deployment에서 사용 중이므로 Nginx 설정을 볼륨으로 마운트  
⚠️ **ConfigMap 변경**: ConfigMap 수정 시 Pod 재시작 필요  
⚠️ **프록시 헤더**: X-Forwarded-* 헤더가 올바르게 전달되는지 모니터링  

## 다음 단계 (필요시)

- [ ] 긴 API 호출에 대한 프록시 타임아웃 조정
- [ ] Nginx 액세스 로그 중앙 집중화
- [ ] API 응답 캐싱 설정 (필요한 경우)
- [ ] Rate limiting 설정 (필요한 경우)

---

**참고 문서**: `/home/sparrow/git/skald/k8s/api-url-architecture-design.md`
