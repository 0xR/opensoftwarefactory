package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

type chatRequest struct {
	Model           string   `json:"model"`
	Messages        []any    `json:"messages"`
	Tools           []any    `json:"tools,omitempty"`
	ReasoningEffort string   `json:"reasoning_effort,omitempty"`
	Temperature     *float64 `json:"temperature,omitempty"`
	Stream          bool     `json:"stream"`
}

// completion is one parsed model response. Message is the assistant message
// exactly as returned, so it can be appended to the conversation unchanged.
type completion struct {
	Message   json.RawMessage
	Content   string
	ToolCalls []toolCall
	Usage     *usage
}

func chat(ctx context.Context, client *http.Client, baseURL string, req chatRequest) (completion, error) {
	data, err := json.Marshal(req)
	if err != nil {
		return completion{}, err
	}
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(baseURL, "/")+"/chat/completions", bytes.NewReader(data))
	if err != nil {
		return completion{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	setCorrelationHeaders(hreq)
	resp, err := client.Do(hreq)
	if err != nil {
		return completion{}, fmt.Errorf("llm gateway: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return completion{}, fmt.Errorf("llm gateway: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			return completion{}, categorizedError{"llm_gateway", fmt.Sprintf("llm gateway: %s: %s", resp.Status, e.Error.Message)}
		}
		return completion{}, categorizedError{"llm_gateway", fmt.Sprintf("llm gateway: %s", resp.Status)}
	}
	var out struct {
		Choices []struct {
			Message json.RawMessage `json:"message"`
		} `json:"choices"`
		Usage *usage `json:"usage"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return completion{}, fmt.Errorf("llm gateway: invalid response: %w", err)
	}
	if len(out.Choices) == 0 || len(out.Choices[0].Message) == 0 {
		return completion{}, fmt.Errorf("llm gateway: response has no message")
	}
	var msg struct {
		Content   *string    `json:"content"`
		ToolCalls []toolCall `json:"tool_calls"`
	}
	if err := json.Unmarshal(out.Choices[0].Message, &msg); err != nil {
		return completion{}, fmt.Errorf("llm gateway: invalid message: %w", err)
	}
	c := completion{Message: out.Choices[0].Message, ToolCalls: msg.ToolCalls, Usage: out.Usage}
	if msg.Content != nil {
		c.Content = *msg.Content
	}
	return c, nil
}
