local M = {}

M._pending = 0
M._latest = nil -- TurnSnapshot
M._job = nil
M._acc = "" -- chunk accumulator for SSE parsing
M.config = {
  url = "http://localhost:3333",
}

local function parse_acc()
  local snapshots = {}
  while true do
    local s, e = M._acc:find("\n\n")
    if not s then break end
    local block = M._acc:sub(1, s - 1)
    M._acc = M._acc:sub(e + 1)
    local event_name, data_str
    for line in block:gmatch("[^\n]+") do
      event_name = line:match("^event: (.+)$") or event_name
      data_str = line:match("^data: (.+)$") or data_str
    end
    if event_name == "turn-complete" and data_str then
      local ok, snap = pcall(vim.json.decode, data_str)
      if ok and type(snap) == "table" then
        table.insert(snapshots, snap)
      end
    end
  end
  return snapshots
end

local function connect()
  M._acc = ""
  M._job = vim.system(
    { "curl", "-N", "--silent", M.config.url .. "/stream" },
    {
      stdout = function(_, data)
        if not data then
          M._job = nil
          vim.defer_fn(connect, 3000)
          return
        end
        M._acc = M._acc .. data
        local snaps = parse_acc()
        if #snaps > 0 then
          vim.schedule(function()
            for _, snap in ipairs(snaps) do
              M._pending = M._pending + 1
              M._latest = snap
            end
            vim.cmd.redrawstatus()
          end)
        end
      end,
    }
  )
end

function M.statusline()
  if M._pending > 0 then
    return "[DV: " .. M._pending .. "]"
  end
  return ""
end

local function build_lines(snap)
  if not snap then return { "(no turns yet)" } end
  local out = {}
  table.insert(out, string.format("-- turn %d  session: %s", snap.turnNumber or 0, snap.sessionId or "?"))
  table.insert(out, "")
  for _, ev in ipairs(snap.events or {}) do
    if ev.unifiedDiff then
      table.insert(out, "--- " .. (ev.path or "?"))
      table.insert(out, "+++ " .. (ev.path or "?"))
      for line in ev.unifiedDiff:gmatch("[^\n]+") do
        table.insert(out, line)
      end
      table.insert(out, "")
    end
  end
  return out
end

local function file_at_cursor(buf)
  local lnum = vim.api.nvim_win_get_cursor(0)[1]
  local lines = vim.api.nvim_buf_get_lines(buf, 0, lnum, false)
  for i = #lines, 1, -1 do
    local p = lines[i]:match("^%-%-%- (.+)$")
    if p then return p end
  end
end

function M.open()
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].filetype = "diff"
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, build_lines(M._latest))
  vim.bo[buf].modifiable = false

  vim.cmd("split")
  vim.api.nvim_win_set_buf(0, buf)

  local function map(key, fn, desc)
    vim.keymap.set("n", key, fn, { buffer = buf, noremap = true, silent = true, desc = desc })
  end

  map("q", function()
    M._pending = 0
    vim.cmd.redrawstatus()
    vim.cmd("close")
  end, "Accept all / close")

  map("d", function()
    local path = file_at_cursor(buf)
    if not path then
      vim.notify("[DV] no file found near cursor", vim.log.levels.WARN)
      return
    end
    local choice = vim.fn.confirm("Revert " .. path .. " with git checkout --?", "&No\n&Yes", 1)
    if choice ~= 2 then return end
    local result = vim.system({ "git", "checkout", "--", path }):wait()
    if result.code ~= 0 then
      vim.notify("[DV] git checkout failed: " .. (result.stderr or ""), vim.log.levels.ERROR)
    else
      vim.notify("[DV] declined: " .. path)
    end
  end, "Decline file (git checkout --)")

  map("c", function()
    local sid = M._latest and (M._latest.rawSessionId or M._latest.sessionId) or ""
    vim.ui.input({ prompt = "Steer > " }, function(text)
      if not text or text == "" then return end
      vim.system({
        "curl", "-s", "-X", "POST", M.config.url .. "/steer",
        "-H", "Content-Type: application/json",
        "-d", vim.json.encode({
          sessionId = sid,
          text = text,
          synthetic = M._latest and M._latest.synthetic == true or nil,
        }),
      })
    end)
  end, "Send steer to agent")
end

function M.setup(opts)
  M.config = vim.tbl_extend("force", M.config, opts or {})
  connect()
  vim.keymap.set("n", "<leader>dv", M.open, { desc = "DiffViewer: open latest turn" })
end

return M
