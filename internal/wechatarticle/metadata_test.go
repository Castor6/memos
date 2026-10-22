package wechatarticle

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestArticleMetadata(t *testing.T) {
	tests := []struct {
		name, header, script string
		want                 Result
	}{
		{name: "article header and global data", header: `<span id="js_author_name">fallback</span><span id="js_author_name_text">十字路口</span><a id="js_name">十字路口Crossing</a>`, script: `var ct = "1792648447"; window.ip_wording = {countryName: '美国', countryId: '840', provinceName: ''}; window.show_ip_wording = '1' * 1;`, want: Result{Author: "十字路口", AccountName: "十字路口Crossing", PublishedAt: "2026年10月22日 13:54", IPLocation: "美国"}},
		{name: "dom date precision", header: `<em id="publish_time">2026年10月22日</em>`, script: `var ct = "1792648447";`, want: Result{PublishedAt: "2026年10月22日"}},
		{name: "escaped literals and domestic province", script: `var author = '\u4f5c\u8005 &amp; O\'Neil'; var nickname = "测试\ud83d\ude00"; var createTime = '2026-10-22 13:54'; window.ip_wording = {'countryName':'中国', countryId:156, provinceName:'广东', cityName:'深圳'}; window.show_ip_wording = true;`, want: Result{Author: "作者 & O'Neil", AccountName: "测试😀", PublishedAt: "2026年10月22日 13:54", IPLocation: "广东"}},
		{name: "hidden IP", script: `window.ip_wording = {countryName:'美国'}; window.show_ip_wording = 0;`, want: Result{}},
		{name: "unknown visibility", script: `window.ip_wording = {countryName:'美国'};`, want: Result{}},
		{name: "ignore unrelated script data", script: `// var author = 'comment';
/* var nickname = 'comment'; */
var sample = "var author = 'example';";
function example() { var author = 'local'; window.ip_wording = {countryName:'美国'}; window.show_ip_wording = 1; }
var recommendations = [{author:'other', nickname:'other', createTime:'2026-10-21'}];
var author = 'dynamic' + suffix; var createTime = '2026-10-22' || '2026-10-21';`, want: Result{}},
		{name: "reject dynamic IP object", script: `window.ip_wording = {countryName: country}; window.show_ip_wording = 1;`, want: Result{}},
		{name: "invalid time", script: `var createTime = '2026-99-22'; var ct = '-1';`, want: Result{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := Extract("https://mp.weixin.qq.com/s/test", `<h1 id="activity-name">Title</h1>`+tt.header+`<div id="js_content"><p>Body</p><span id="js_name"></span><script>var author = 'body example';</script></div><script>`+tt.script+`</script>`)
			require.NoError(t, err)
			require.Equal(t, tt.want.Author, result.Author)
			require.Equal(t, tt.want.AccountName, result.AccountName)
			require.Equal(t, tt.want.PublishedAt, result.PublishedAt)
			require.Equal(t, tt.want.IPLocation, result.IPLocation)
		})
	}
}
