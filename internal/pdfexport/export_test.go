package pdfexport

import (
	"bytes"
	"image"
	"image/png"
	"strings"
	"testing"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"
)

func TestPrepareCompleteBody(t *testing.T) {
	var data bytes.Buffer
	require.NoError(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 10, 10))))
	calls := 0
	body, err := Prepare("# 中文标题\n\n- [x] 完成\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | 通过 |\n\n![图片](/file/attachments/test/a.png)\n\n![重复](/file/attachments/test/a.png)\n\n![文件](/file/attachments/doc/a.pdf \"memos:file:application/pdf\")\n\n![引用](/memos/other \"memos:reference\")\n\n"+strings.Repeat("完整长文。\n\n", 200), "https://memos.example", func(src string) ([]byte, error) {
		calls++
		require.Equal(t, "/file/attachments/test/a.png", src)
		return data.Bytes(), nil
	})
	require.NoError(t, err)
	require.Equal(t, 1, calls)
	require.Equal(t, 2, strings.Count(body, `width="10"`))
	for _, value := range []string{"中文标题", "checked", "<table>", "data:image/png;base64,", "https://memos.example/file/attachments/doc/a.pdf", "https://memos.example/memos/other"} {
		require.Contains(t, body, value)
	}
	require.Equal(t, 200, strings.Count(body, "完整长文。"))
}

func TestPrepareFailsInsteadOfDroppingImages(t *testing.T) {
	_, err := Prepare("![图片](https://example.com/missing)", "", func(string) ([]byte, error) { return nil, errors.New("not found") })
	require.ErrorContains(t, err, "读取正文图片失败")
	_, err = Prepare("![图片](https://example.com/invalid)", "", func(string) ([]byte, error) { return []byte("not an image"), nil })
	require.ErrorContains(t, err, "图片格式无法解码")
}

func TestPreparePreservesCurrencyAndMathSource(t *testing.T) {
	for _, content := range []string{"$20 and $30", "Price: \\$20", "$x+y$ and $$x^2$$"} {
		body, err := Prepare(content, "", func(string) ([]byte, error) {
			t.Fatal("plain text must not fetch images")
			return nil, nil
		})
		require.NoError(t, err)
		require.Contains(t, body, strings.ReplaceAll(content, `\$`, `$`))
		require.NotContains(t, body, "math-inline")
	}
}
