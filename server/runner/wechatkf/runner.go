// Package wechatkf runs the built-in personal clipping consumer with durable state.
package wechatkf

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/errors"

	core "github.com/usememos/memos/internal/wechatkf"
	"github.com/usememos/memos/store"
)

// Remote is the bounded official API surface used by the worker.
type Remote interface {
	Sync(context.Context, string, string) (core.Page, error)
	Download(context.Context, string) (core.Media, error)
	SendText(context.Context, string, string, string) error
	Close()
}

// Runner owns no independent database or long-term attachment storage.
type Runner struct {
	store  *store.Store
	secret string
	notes  func(core.Config) core.Notes
	remote func(core.Config) (Remote, error)
	wake   chan struct{}
}

// New creates a disabled-by-default worker; Run follows encrypted stored settings.
func New(s *store.Store, secret string, notes func(core.Config) core.Notes) *Runner {
	return &Runner{store: s, secret: secret, notes: notes, wake: make(chan struct{}, 1), remote: func(c core.Config) (Remote, error) {
		return core.NewClient(c.Binding, c.Secret, int64(c.MaxMediaMB)<<20)
	}}
}

// Wake prompts a recheck without blocking an HTTP callback.
func (r *Runner) Wake() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Run reloads settings and stops the previous consumer before starting a new one.
func (r *Runner) Run(ctx context.Context) {
	var stop context.CancelFunc
	var done chan struct{}
	var revision int64 = -1
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer func() {
		if stop != nil {
			stop()
			<-done
		}
	}()
	for {
		state, err := r.store.WeChatConfiguration(ctx)
		if err == nil && state.Revision != revision && stop != nil {
			stop()
			<-done
			stop = nil
			done = nil
		}
		if err == nil && stop == nil {
			config, err := core.OpenConfig(state.Value, r.secret)
			if err == nil && config.Enabled && config.Validate() == nil {
				revision = state.Revision
				session, cancel := context.WithCancel(ctx)
				stop = cancel
				done = make(chan struct{})
				go func(completed chan struct{}, version int64) {
					defer close(completed)
					defer cancel()
					r.session(session, config, version)
				}(done, revision)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-done:
			stop = nil
			done = nil
		case <-ticker.C:
		case <-r.wake:
		}
	}
}
func (r *Runner) session(ctx context.Context, config core.Config, revision int64) {
	owner := uuid.NewString()
	acquired, err := r.store.AcquireWeChatConsumer(ctx, owner, revision, time.Now().Unix())
	if err != nil || !acquired {
		select {
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
		}
		return
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer func() {
		release, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := r.store.ReleaseWeChatConsumer(release, owner); err != nil {
			slog.Warn("wechat_kf_lease_release_failed")
		}
	}()
	defer func() {
		if recover() != nil {
			slog.Error("wechat_kf_worker_interrupted")
		}
	}()
	remote, err := r.remote(config)
	if err != nil {
		slog.Error("wechat_kf_client_configuration_invalid")
		return
	}
	defer remote.Close()
	processor, err := core.NewProcessor(config.Binding, r.notes(config), remote.Download)
	if err != nil {
		slog.Error("wechat_kf_binding_invalid")
		return
	}
	var renew sync.WaitGroup
	renew.Add(1)
	go func() {
		defer renew.Done()
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if r.store.RenewWeChatConsumer(ctx, owner, revision, time.Now().Unix()) != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); renew.Wait() }()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := r.tick(ctx, owner, revision, config, remote, processor); err != nil {
			if ctx.Err() != nil || errors.Is(err, store.ErrWeChatLease) {
				return
			}
			slog.Warn("wechat_kf_state_operation_failed")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-r.wake:
		}
	}
}
func safeReason(err error) string {
	var failure *core.Failure
	if errors.As(err, &failure) {
		return failure.Error()
	}
	var remote *core.RemoteError
	if errors.As(err, &remote) {
		return remote.Error()
	}
	return "内部处理错误"
}
func (r *Runner) tick(ctx context.Context, owner string, revision int64, config core.Config, remote Remote, processor *core.Processor) error {
	nowSec := time.Now().Unix()
	sync, err := r.store.ReadWeChatSync(ctx)
	if err != nil {
		return err
	}
	if sync.NextAt <= nowSec {
		token := ""
		if nowSec-sync.TokenTime < 540 {
			token = sync.Token
		}
		page, err := remote.Sync(ctx, sync.Cursor, token)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if err = r.store.FinishWeChatSync(ctx, owner, revision, sync.Generation, nowSec+60, safeReason(err)); err != nil {
				return err
			}
		} else {
			if err = r.store.AcceptWeChatPage(ctx, owner, revision, page.Cursor, page.Messages, config.Binding, nowSec); err != nil {
				return err
			}
			if page.HasMore == 0 {
				if err = r.store.FinishWeChatSync(ctx, owner, revision, sync.Generation, nowSec+int64(config.PollSeconds), ""); err != nil {
					return err
				}
			}
		}
	}
	job, err := r.store.NextWeChatJob(ctx, nowSec)
	if err != nil {
		return err
	}
	if job != nil {
		var message core.Message
		err = json.Unmarshal([]byte(job.Payload), &message)
		var out core.Outcome
		if err == nil {
			out, err = processor.ProcessWithProgress(ctx, message, func(id string) error { return r.store.MarkWeChatDraft(ctx, owner, revision, job.ID, id) })
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			if out.MemoID == "" {
				out.MemoID = job.Memo
			}
			reply := ""
			if config.Receipts {
				reply = core.FailureReply(job.Kind, out, err, job.Attempts+1)
			}
			if err = r.store.FailWeChatJob(ctx, owner, revision, *job, out.MemoID, safeReason(err), reply, nowSec); err != nil {
				return err
			}
		} else {
			reply := out.Reply
			if !config.Receipts || out.Ignored {
				reply = ""
			}
			if err = r.store.CompleteWeChatJob(ctx, owner, revision, *job, out.MemoID, reply, nowSec); err != nil {
				return err
			}
		}
	}
	if !config.Receipts {
		return nil
	}
	allowed := map[string]bool{}
	for _, user := range config.AllowedUsers {
		allowed[user] = true
	}
	reply, err := r.store.ReserveWeChatReply(ctx, owner, revision, nowSec, allowed)
	if err != nil || reply == nil {
		return err
	}
	err = remote.SendText(ctx, reply.User, reply.ID, reply.Content)
	// If cancelled after dispatch, leave "sending" for recovery as "unknown".
	if ctx.Err() != nil {
		return ctx.Err()
	}
	state, detail := "sent", ""
	if err != nil {
		detail = safeReason(err)
		state = "unknown"
		var remote *core.RemoteError
		if errors.As(err, &remote) && !remote.Unknown {
			state = "failed"
			if reply.Attempts < 4 {
				state = "pending"
			}
		}
	}
	return r.store.FinishWeChatReply(ctx, owner, revision, *reply, state, detail, time.Now().Unix())
}
