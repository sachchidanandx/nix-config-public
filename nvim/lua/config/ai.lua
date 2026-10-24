---@brief [[
--- Session-scoped AI agent selection.
---
--- Exactly one agent owns the <leader>a keys at a time. <leader>aa switches
--- agents for the rest of this nvim session; the outgoing agent's keys are
--- unmapped, so it behaves as if it were disabled. The choice lives in memory
--- only -- a fresh nvim always starts on `claude`.
---
---   <leader>aa  choose the active agent (session-scoped)
---   <leader>ac  continue / resume the previous session
---   <leader>an  brand-new session
---   <leader>as  send visual selection (v) / current buffer (n) / the file
---               under the cursor in a snacks picker
---   <leader>ao  toggle the agent terminal
---   <leader>ap  prompt with the selection (immediate turn)
---   <C-/>       hide the visible agent terminal (see config/keymaps.lua)
---
--- Agents may add their own keys on top (claude gets diff accept/deny and
--- model selection); those come and go with the agent too.
---
--- Lazy-loading: the actions go through `require(...)`, which lazy.nvim
--- resolves to the owning plugin and auto-loads on first press, so nothing
--- here loads a plugin at startup. The read-only probes (`is_visible`) go
--- through `package.loaded` instead, so <C-/> never loads an agent just to
--- ask whether it is on screen.
---@brief ]]

---@class AiAgent
---@field name string                 unique key; what <leader>aa stores
---@field label string                label shown in the picker
---@field plugin string               lazy plugin name (availability check)
---@field module string               main lua module (package.loaded probe)
---@field keys AiKey[]                mapped as <leader>a<suffix> while active
---@field add_file fun(path: string)  attach a specific file as context
---@field is_visible fun(): boolean   only called once `module` is loaded
---@field hide fun()                  hide the window, keep the session alive

---@class AiKey
---@field [1] string                  key suffix, appended to <leader>a
---@field [2] string|function         rhs
---@field mode? string|string[]       defaults to "n"
---@field desc string                 prefixed with the agent name

local M = {}

-- ---- pi.nvim -------------------------------------------------------------

---@type AiAgent
local pi = {
  name = "pi",
  label = "pi      (pi.nvim)",
  plugin = "pi.nvim",
  module = "pinvim",
  keys = {
    {
      "c",
      function()
        require("pinvim").resume()
      end,
      desc = "continue previous session",
    },
    {
      "n",
      function()
        require("pinvim").new_session()
      end,
      desc = "new session",
    },
    {
      "s",
      function()
        require("pinvim").send()
      end,
      mode = { "n", "v" },
      desc = "send selection / buffer",
    },
    {
      "o",
      function()
        require("pinvim").toggle()
      end,
      desc = "toggle terminal",
    },
    { "p", "<cmd>PiSend!<cr>", mode = "v", desc = "prompt with selection (immediate turn)" },
    -- files pi changed: quickfix list + mini.diff overlay (pi.nvim :PiReview)
    { "r", "<cmd>PiReview<cr>", desc = "review changed files" },
  },
  add_file = function(path)
    require("pinvim").add(path)
  end,
  is_visible = function()
    return require("pinvim").is_visible()
  end,
  hide = function()
    require("pinvim").hide()
  end,
}

-- ---- claudecode.nvim -----------------------------------------------------

--- The window currently showing the claude terminal, if it is on screen.
--- Never loads the plugin: callers must have required it already.
---@return integer|nil win, integer|nil buf
local function claude_win()
  local ok, term = pcall(require, "claudecode.terminal")
  if not ok then
    return nil, nil
  end
  local buf = term.get_active_terminal_bufnr()
  if not buf or not vim.api.nvim_buf_is_valid(buf) then
    return nil, nil
  end
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    -- claudecode hides its float with nvim_win_set_config({ hide = true }),
    -- which keeps the window handle valid -- so ask the window config too.
    local cfg = vim.api.nvim_win_get_config(win)
    if not cfg.hide then
      return win, buf
    end
  end
  return nil, buf
end

---@type AiAgent
local claude = {
  name = "claude",
  label = "claude  (claudecode.nvim)",
  plugin = "claudecode.nvim",
  module = "claudecode",
  keys = {
    -- open() reuses and focuses a live terminal and ignores cmd_args; it only
    -- spawns with --continue when nothing is alive. Same shape as pi's resume.
    {
      "c",
      function()
        require("claudecode.terminal").open(nil, "--continue")
      end,
      desc = "continue previous session",
    },
    {
      "n",
      function()
        local term = require("claudecode.terminal")
        local buf = term.get_active_terminal_bufnr()
        -- The snacks provider caches a single terminal and ignores cmd_args
        -- while it is alive, so a *new* session means tearing the old one down
        -- first. Wiping the buffer is what drops the cached instance
        -- (its BufWipeout handler), letting open() spawn a fresh claude.
        term.close()
        if buf and vim.api.nvim_buf_is_valid(buf) then
          pcall(vim.api.nvim_buf_delete, buf, { force = true })
        end
        vim.schedule(function()
          term.open()
        end)
      end,
      desc = "new session",
    },
    {
      "s",
      function()
        local path = vim.api.nvim_buf_get_name(0)
        if path == "" or vim.fn.filereadable(path) == 0 then
          vim.notify("No file to send (buffer has no path or file unreadable).", vim.log.levels.WARN, { title = "ai" })
          return
        end
        -- Queues the mention and launches claude when it is not connected yet.
        require("claudecode").send_at_mention(path, nil, nil, "keymap")
      end,
      mode = "n",
      desc = "send buffer",
    },
    { "s", "<cmd>ClaudeCodeSend<cr>", mode = "v", desc = "send selection" },
    {
      "o",
      function()
        require("claudecode.terminal").simple_toggle()
      end,
      desc = "toggle terminal",
    },
    {
      "p",
      function()
        -- Best-effort equivalent of pi's PiSend!: at-mention the selection,
        -- then fire a turn once the mention has been accepted. The mention
        -- reaches claude's prompt over the websocket, so give it a beat before
        -- typing on top of it.
        vim.api.nvim_create_autocmd("User", {
          pattern = "ClaudeCodeSendComplete",
          once = true,
          callback = function()
            vim.defer_fn(function()
              require("claudecode.terminal").send_to_terminal("Help me with this selection.", {
                submit = true,
                focus = true,
              })
            end, 150)
          end,
        })
        vim.cmd("ClaudeCodeSend")
      end,
      mode = "v",
      desc = "prompt with selection (immediate turn)",
    },
    -- claude-only extras. Diffs are also accepted with :w and rejected with
    -- :q inside the proposed-change buffer; <leader>aa is the agent selector.
    { "y", "<cmd>ClaudeCodeDiffAccept<cr>", desc = "accept diff" },
    { "d", "<cmd>ClaudeCodeDiffDeny<cr>", desc = "deny diff" },
    { "m", "<cmd>ClaudeCodeSelectModel<cr>", desc = "select model" },
  },
  add_file = function(path)
    require("claudecode").send_at_mention(path, nil, nil, "picker")
  end,
  is_visible = function()
    return (select(1, claude_win())) ~= nil
  end,
  hide = function()
    local win, buf = claude_win()
    if not win then
      return
    end
    -- Prefer the snacks terminal object: its :hide() (patched by claudecode to
    -- preserve the cursor anchor) keeps the job alive, while
    -- claudecode's terminal.close() would destroy the session.
    for _, term in ipairs((Snacks and Snacks.terminal.list()) or {}) do
      if term.buf == buf then
        term:hide()
        return
      end
    end
    pcall(vim.api.nvim_win_hide, win)
  end,
}

-- ---- registry ------------------------------------------------------------

---@type AiAgent[]
M.agents = { pi, claude }

--- Agent every fresh nvim session starts on (never persisted).
M.default = "pi"

---@type string|nil
M.active = nil

--- Keys we mapped for the active agent, so we can unmap them on a switch.
---@type table[]
local mapped = {}

--- Agents whose plugin is actually part of the lazy spec.
---@return AiAgent[]
local function available()
  return vim.tbl_filter(function(a)
    return LazyVim.has(a.plugin)
  end, M.agents)
end

---@return AiAgent|nil
function M.get()
  for _, a in ipairs(M.agents) do
    if a.name == M.active then
      return a
    end
  end
end

--- Make `name` the active agent: hand it the whole <leader>a namespace and
--- take it away from whoever had it.
---@param name string
---@param opts? { notify?: boolean }
function M.set(name, opts)
  opts = opts or {}
  local agent
  for _, a in ipairs(available()) do
    if a.name == name then
      agent = a
      break
    end
  end
  if not agent then
    vim.notify("Unknown AI agent: " .. tostring(name), vim.log.levels.WARN, { title = "ai" })
    return
  end

  local prev = M.get()
  -- Don't strand the outgoing agent's float on screen with no key left to
  -- hide it. Its session keeps running, so switching back resumes it.
  if prev and prev ~= agent and package.loaded[prev.module] and prev.is_visible() then
    prev.hide()
  end

  for _, m in ipairs(mapped) do
    pcall(vim.keymap.del, m[1], m[2])
  end
  mapped = {}
  for _, key in ipairs(agent.keys) do
    local mode = key.mode or "n"
    local lhs = "<leader>a" .. key[1]
    vim.keymap.set(mode, lhs, key[2], { desc = agent.name .. ": " .. key.desc, silent = true })
    table.insert(mapped, { mode, lhs })
  end

  M.active = agent.name
  if opts.notify then
    vim.notify("Active AI agent: " .. agent.label, vim.log.levels.INFO, { title = "ai" })
  end
end

--- Pick the active agent (snacks backs vim.ui.select here).
function M.select()
  local items = available()
  if #items == 0 then
    vim.notify("No AI agent integrations installed", vim.log.levels.WARN, { title = "ai" })
    return
  end
  vim.ui.select(items, {
    prompt = "AI agent for this session",
    ---@param a AiAgent
    format_item = function(a)
      return (a.name == M.active and "● " or "  ") .. a.label
    end,
  }, function(choice)
    if choice then
      M.set(choice.name, { notify = true })
    end
  end)
end

--- Send the file under the cursor in a snacks picker to the active agent.
function M.send_picker_file()
  if not Snacks then
    return
  end
  -- The mapping is buffer-local to the picker list, so the picker we want is
  -- the one owning the current window.
  local cur = vim.api.nvim_get_current_win()
  local picker
  for _, p in ipairs(Snacks.picker.get({ tab = true }) or {}) do
    if p.list and p.list.win and p.list.win.win == cur then
      picker = p
      break
    end
  end
  local item = picker and picker.list:current()
  -- item.file can be relative to the picker's cwd; agents want a real path.
  local path = item and Snacks.picker.util.path(item)
  local agent = M.get()
  if not (path and agent) then
    return
  end
  -- Close before sending: closing hands focus back to the window the picker
  -- was opened from, which would undo focus-on-send otherwise.
  picker:close()
  agent.add_file(path)
end

--- Hide whichever agent terminal is on screen; the active one goes first.
--- Only probes agents that are already loaded, so this never lazy-loads.
---@return boolean hid
function M.hide_visible()
  local active = M.get()
  local order = {}
  if active then
    order[1] = active
  end
  for _, a in ipairs(M.agents) do
    if a ~= active then
      order[#order + 1] = a
    end
  end
  for _, a in ipairs(order) do
    if package.loaded[a.module] and a.is_visible() then
      a.hide()
      return true
    end
  end
  return false
end

function M.setup()
  vim.keymap.set({ "n", "v" }, "<leader>aa", M.select, { desc = "ai: select agent for this session" })

  -- Buffer-local override inside snacks picker lists. This is what lazy's
  -- `ft = "snacks_picker_list"` key filter did before the keys moved out of
  -- the plugin specs; dispatching at call time means it survives a switch.
  vim.api.nvim_create_autocmd("FileType", {
    group = vim.api.nvim_create_augroup("ai_picker_send", { clear = true }),
    pattern = "snacks_picker_list",
    callback = function(ev)
      vim.keymap.set("n", "<leader>as", M.send_picker_file, {
        buffer = ev.buf,
        desc = "ai: send file",
      })
    end,
  })

  vim.api.nvim_create_user_command("AiAgent", function(o)
    if o.args == "" then
      M.select()
    else
      M.set(o.args, { notify = true })
    end
  end, {
    nargs = "?",
    complete = function()
      return vim.tbl_map(function(a)
        return a.name
      end, available())
    end,
    desc = "Show/choose the active AI agent for this session",
  })

  local names = vim.tbl_map(function(a)
    return a.name
  end, available())
  local start = vim.tbl_contains(names, M.default) and M.default or names[1]
  if start then
    M.set(start)
  end
end

return M
