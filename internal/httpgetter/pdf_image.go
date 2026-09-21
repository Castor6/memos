package httpgetter

import (
	"context"
	"net/http"

	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/pdfexport"
)

// GetPDFImage fetches a bounded image using the metadata client's SSRF protections.
func GetPDFImage(ctx context.Context, address string) ([]byte, error) {
	if err := validateURL(address); err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("图片下载失败")
	}
	return pdfexport.ReadImage(response.Body)
}
