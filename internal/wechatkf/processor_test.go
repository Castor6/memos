package wechatkf

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type recordingNotes struct {
	ensured  int
	finished int
	content  string
}

func (n *recordingNotes) Ensure(_ context.Context, _ string, clip Clip) error {
	n.ensured++
	n.content = clip.Content
	return nil
}
func (n *recordingNotes) Finish(_ context.Context, _ string, clip Clip) error {
	n.finished++
	n.content = clip.Content
	return nil
}
func (*recordingNotes) Attach(context.Context, string, string, string, string, Download) (string, error) {
	return "attachment", nil
}

func TestProcessorIgnoresOnlyStandaloneOne(t *testing.T) {
	for _, content := range []string{"1", " 1", "1\n", "11", "1 #工作", "第一条 1"} {
		t.Run(content, func(t *testing.T) {
			notes := &recordingNotes{}
			processor, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, notes, nil)
			require.NoError(t, err)
			progress := 0
			out, err := processor.ProcessWithProgress(context.Background(), Message{"msgid": "input", "msgtype": "text", "text": map[string]any{"content": content}, "external_userid": "self", "open_kfid": "kf", "origin": 3}, func(string) error { progress++; return nil })
			require.NoError(t, err)
			if content == "1" {
				require.True(t, out.Ignored)
				require.Empty(t, out.MemoID)
				require.Empty(t, out.Reply)
				require.Zero(t, notes.ensured)
				require.Zero(t, notes.finished)
				require.Zero(t, progress)
			} else {
				require.False(t, out.Ignored)
				require.NotEmpty(t, out.MemoID)
				require.Equal(t, "文字保存成功", out.Reply)
				require.Equal(t, 1, notes.finished)
			}
		})
	}
}

func TestProcessorKeepsOneInsideChat(t *testing.T) {
	notes := &recordingNotes{}
	processor, err := NewProcessor(Binding{CorpID: "corp", KFID: "kf", AllowedUsers: []string{"self"}}, notes, nil)
	require.NoError(t, err)
	out, err := processor.Process(context.Background(), Message{"msgid": "chat", "msgtype": "merged_msg", "external_userid": "self", "open_kfid": "kf", "origin": 3, "merged_msg": map[string]any{"item": []any{map[string]any{"msgtype": "text", "msg_content": map[string]any{"text": map[string]any{"content": "1"}}}}}})
	require.NoError(t, err)
	require.False(t, out.Ignored)
	require.Equal(t, 1, notes.finished)
	require.Contains(t, notes.content, "1")
}
