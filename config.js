/* 설정 파일. 행정안전부 도로명주소 검색 API 승인키를 넣는다.
   승인키 발급: https://business.juso.go.kr (도로명주소 검색 API) */
window.ZIPCODE_CONFIG = {
  jusoKey: "devU01TX0FVVEgyMDI2MTAyMDAyMTAxMjEyMDc3MDM=",
  maxRows: 5000,
  concurrency: 3,
  // 사람이 직접 확인할 때 여는 인터넷우체국 검색 화면
  manualSearchUrl: "https://www.epost.kr/search.RetrieveIntegrationNewZipCdList.comm",
};
