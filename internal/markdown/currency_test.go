package markdown

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCurrencyAndFormulaSourceRemainLiteral(t *testing.T) {
	service := NewService()
	for _, content := range []string{"$20 and $30", "$x+y$ and $$x^2$$"} {
		rendered, err := service.RenderHTML([]byte(content))
		require.NoError(t, err)
		require.Contains(t, rendered, content)
		roundTrip, err := service.RenderMarkdown([]byte(content))
		require.NoError(t, err)
		require.Equal(t, content, roundTrip)
	}
}
