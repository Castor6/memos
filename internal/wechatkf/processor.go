package wechatkf

import (
	"context"
	"strconv"
	"strings"

	"github.com/pkg/errors"
)

// Notes is implemented by Memos' existing business services, never by self-HTTP.
// Calls are serialized by the future durable worker, and must tolerate replay.
type Notes interface {
	Ensure(context.Context, string, Clip) error
	Attach(context.Context, string, string, string, string, Download) (string, error)
	Finish(context.Context, string, Clip) error
}

// Media holds one bounded download in memory; only Memos stores it permanently.
type Media struct {
	Data           []byte
	Type, Filename string
}

// Download fetches an official media identifier, not an arbitrary URL.
type Download func(context.Context, string) (Media, error)

// Binding is trusted server configuration, never derived from incoming messages.
type Binding struct {
	CorpID, KFID string
	AllowedUsers []string
	DefaultTags  []string
	ChatTag      string
}

// Processor performs one authorized clipping attempt. It does not acknowledge a
// callback, advance cursors, retry, or send replies: those require durable state.
type Processor struct {
	binding  Binding
	notes    Notes
	download Download
}

// NewProcessor copies the allowlist so callers cannot mutate it after construction.
func NewProcessor(binding Binding, notes Notes, download Download) (*Processor, error) {
	if binding.CorpID == "" || binding.KFID == "" || len(binding.AllowedUsers) == 0 || notes == nil {
		return nil, errors.New("invalid WeChat binding")
	}
	for _, user := range binding.AllowedUsers {
		if user == "" {
			return nil, errors.New("empty WeChat sender")
		}
	}
	binding.AllowedUsers = append([]string(nil), binding.AllowedUsers...)
	binding.DefaultTags = append([]string(nil), binding.DefaultTags...)
	return &Processor{binding: binding, notes: notes, download: download}, nil
}

// Outcome is recorded by the future queue before a result receipt can be sent.
type Outcome struct {
	Ignored bool
	MemoID  string
	Reply   string
}

// Process saves one input as one private memo and its attachments. A successful
// return alone is not permission to send: the worker must persist the outcome.
func (p *Processor) Process(ctx context.Context, message Message) (Outcome, error) {
	user := stringValue(message["external_userid"])
	allowed := false
	for _, id := range p.binding.AllowedUsers {
		allowed = allowed || id == user
	}
	if !allowed || stringValue(message["open_kfid"]) != p.binding.KFID || stringValue(message["origin"]) != "3" {
		return Outcome{Ignored: true}, nil
	}
	id := stringValue(message["msgid"])
	if id == "" {
		return Outcome{}, errors.New("missing WeChat message ID")
	}
	kind := stringValue(message["msgtype"])
	clip, err := Render(message, p.binding.DefaultTags, p.binding.ChatTag, func(_, kind string) (string, error) { return "[" + Label(kind) + "：待保存]", nil })
	if err != nil {
		return Outcome{}, failure("解析消息", err)
	}
	if clip.Unsupported {
		return Outcome{Reply: Label(kind) + "保存失败：" + strings.Join(clip.Issues, "；")}, nil
	}
	uid := StableID(p.binding.CorpID, p.binding.KFID, id)
	if err := p.notes.Ensure(ctx, uid, clip); err != nil {
		return Outcome{}, failure("创建笔记", err)
	}
	out := Outcome{MemoID: uid}
	clip, err = Render(message, p.binding.DefaultTags, p.binding.ChatTag, func(mediaID, kind string) (string, error) {
		return p.notes.Attach(ctx, uid, StableID(uid, mediaID), mediaID, kind, p.download)
	})
	if err != nil {
		return out, failure("保存附件", err)
	}
	if err := p.notes.Finish(ctx, uid, clip); err != nil {
		return out, failure("更新笔记", err)
	}
	out.Reply = Label(kind) + "保存成功"
	if len(clip.Issues) > 0 {
		out.Reply = Label(kind) + "部分保存：" + strings.Join(clip.Issues, "；")
	}
	return out, nil
}

// Failure omits raw upstream errors, URLs and response bodies from receipts/logs.
type Failure struct{ Stage, Reason string }

func (f *Failure) Error() string { return f.Stage + "：" + f.Reason }

func failure(stage string, err error) error {
	var safe *Failure
	if errors.As(err, &safe) {
		return safe
	}
	reason := "内部处理错误"
	var remote *RemoteError
	if errors.As(err, &remote) {
		reason = remote.Error()
	}
	return &Failure{Stage: stage, Reason: reason}
}

// FailureReply is used only after the durable retry policy has been exhausted.
func FailureReply(kind string, outcome Outcome, err error, attempts int) string {
	prefix := Label(kind) + "保存失败"
	if outcome.MemoID != "" {
		prefix = Label(kind) + "部分保存"
	}
	return prefix + "：" + failure("处理消息", err).Error() + "（尝试 " + strconv.Itoa(attempts) + " 次）"
}
