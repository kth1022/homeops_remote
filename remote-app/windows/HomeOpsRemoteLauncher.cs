using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Windows.Forms;

namespace HomeOpsRemote
{
    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }

    internal sealed class MainForm : Form
    {
        private const string Root = @"C:\Users\kth10\Documents\home-ops";
        private const string RemoteRoot = Root + @"\remote-app";
        private const string TokenPath = RemoteRoot + @"\config\homeops.remote.token.txt";
        private const string ConfigPath = RemoteRoot + @"\config\homeops.remote.json";
        private const string NodeTaskName = "HomeOps Remote Node";
        private const string PrimaryUrl = "http://127.0.0.1:8787";
        private const string FallbackUrl = "http://100.97.88.6:8787";
        private const string TailscalePath = @"C:\Program Files\Tailscale\tailscale.exe";
        private const string PowerShellPath = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        private const int StatusRequestTimeoutMs = 30000;
        private const int CommandRequestTimeoutMs = 300000;

        private readonly TextBox logBox;
        private readonly TextBox apiUrlBox;
        private readonly Label statusLabel;

        public MainForm()
        {
            Text = "HomeOps Remote";
            Width = 980;
            Height = 720;
            MinimumSize = new Size(820, 560);
            StartPosition = FormStartPosition.CenterScreen;

            var root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.RowCount = 4;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 78));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 252));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Controls.Add(root);

            var header = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(17, 24, 39), Padding = new Padding(18, 12, 18, 10) };
            var title = new Label
            {
                Text = "HomeOps Remote",
                ForeColor = Color.White,
                Font = new Font(Font.FontFamily, 18, FontStyle.Bold),
                Dock = DockStyle.Top,
                Height = 34
            };
            statusLabel = new Label
            {
                Text = "Local control panel for HomeOps Remote",
                ForeColor = Color.FromArgb(203, 213, 225),
                Dock = DockStyle.Top,
                Height = 24
            };
            header.Controls.Add(statusLabel);
            header.Controls.Add(title);
            root.Controls.Add(header, 0, 0);

            var apiPanel = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12, 10, 12, 4), ColumnCount = 3 };
            apiPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 82));
            apiPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            apiPanel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 146));
            apiPanel.Controls.Add(new Label { Text = "API URL", Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
            apiUrlBox = new TextBox { Text = PrimaryUrl, Dock = DockStyle.Fill };
            apiPanel.Controls.Add(apiUrlBox, 1, 0);
            apiPanel.Controls.Add(Button("Use fallback", delegate { apiUrlBox.Text = FallbackUrl; }), 2, 0);
            root.Controls.Add(apiPanel, 0, 1);

            var actions = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(12), ColumnCount = 4, RowCount = 5 };
            for (int i = 0; i < 4; i++) actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            for (int i = 0; i < 5; i++) actions.RowStyles.Add(new RowStyle(SizeType.Percent, 20));
            AddAction(actions, 0, 0, "Open dashboard", OpenDashboard);
            AddAction(actions, 1, 0, "API status", delegate { RunApiGet("/api/status"); });
            AddAction(actions, 2, 0, "Command history", delegate { RunApiGet("/api/commands"); });
            AddAction(actions, 3, 0, "Readiness report", delegate { RunPowerShellScript(@"remote-app\server\Test-HomeOpsRemoteRouterReadiness.ps1"); });
            AddAction(actions, 0, 1, "HomeOps Check", delegate { RunApiCommand("homeops.check", "Run HomeOps check"); });
            AddAction(actions, 1, 1, "HA Monitor", delegate { RunApiCommand("homeassistant.monitor", "Run Home Assistant monitor"); });
            AddAction(actions, 2, 1, "LAN Inventory", delegate { RunApiCommand("lan.inventory", "Run LAN inventory"); });
            AddAction(actions, 3, 1, "Queue message", QueueMessage);
            AddAction(actions, 0, 2, "Start server task", delegate { RunPowerShell("-Command \"Start-ScheduledTask -TaskName 'HomeOps Remote Node'; Get-ScheduledTask -TaskName 'HomeOps Remote Node' | Select TaskName,State | Format-List\""); });
            AddAction(actions, 1, 2, "Restart server task", delegate { RunPowerShell("-Command \"Stop-ScheduledTask -TaskName 'HomeOps Remote Node'; Start-ScheduledTask -TaskName 'HomeOps Remote Node'; Start-Sleep -Seconds 2; Get-ScheduledTask -TaskName 'HomeOps Remote Node' | Select TaskName,State | Format-List\""); });
            AddAction(actions, 2, 2, "Install server task", delegate { RunPowerShellScript(@"remote-app\server\New-HomeOpsRemoteNodeTask.ps1", "-RunNow"); });
            AddAction(actions, 3, 2, "Firewall rule", delegate { RunPowerShellScript(@"remote-app\server\Enable-HomeOpsRemoteFirewallRule.ps1"); });
            AddAction(actions, 0, 3, "Tailscale status", delegate { RunProcess(TailscalePath, "status", Root); });
            AddAction(actions, 1, 3, "Serve status", delegate { RunProcess(TailscalePath, "serve status", Root); });
            AddAction(actions, 2, 3, "Configure Serve", ConfigureServe);
            AddAction(actions, 3, 3, "Rotate token", RotateToken);
            AddAction(actions, 0, 4, "Plex Duplicates", delegate { RunApiCommand("plex.duplicates.scan", "Run Plex duplicate movie scan"); });
            root.Controls.Add(actions, 0, 2);

            logBox = new TextBox
            {
                Dock = DockStyle.Fill,
                Multiline = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                ReadOnly = true,
                Font = new Font("Consolas", 10),
                BackColor = Color.FromArgb(248, 250, 252),
                ForeColor = Color.FromArgb(31, 41, 55)
            };
            root.Controls.Add(logBox, 0, 3);

            Shown += delegate { InitialCheck(); };
        }

        private Button Button(string text, EventHandler handler)
        {
            var button = new Button { Text = text, Dock = DockStyle.Fill, Margin = new Padding(5), Height = 42 };
            button.Click += handler;
            return button;
        }

        private void AddAction(TableLayoutPanel panel, int column, int row, string text, Action action)
        {
            panel.Controls.Add(Button(text, delegate { SafeRun(action); }), column, row);
        }

        private void SafeRun(Action action)
        {
            try
            {
                action();
            }
            catch (Exception ex)
            {
                Append("ERROR: " + ex.Message);
            }
        }

        private void InitialCheck()
        {
            Append("HomeOps Remote launcher ready.");
            Append("Primary URL: " + PrimaryUrl);
            Append("Token file: " + TokenPath);
            if (!File.Exists(TokenPath))
            {
                Append("WARNING: token file not found. Use Rotate token or run New-HomeOpsRemoteToken.ps1.");
            }
            RunApiGet("/api/status");
        }

        private void QueueMessage()
        {
            string message = Prompt("Message to queue for review:", "Queue message");
            if (string.IsNullOrWhiteSpace(message)) return;
            RunApiCommand("message", message);
        }

        private void ConfigureServe()
        {
            RunProcess(TailscalePath, "serve --bg --https=443 http://127.0.0.1:8787", Root);
            RunProcess(TailscalePath, "serve --bg --http=8080 http://127.0.0.1:8787", Root);
            RunProcess(TailscalePath, "serve status", Root);
        }

        private void RotateToken()
        {
            var result = MessageBox.Show(
                "Rotating the token will require updating the Android app token. Continue?",
                "Rotate HomeOps token",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (result != DialogResult.Yes) return;
            RunPowerShellScript(@"remote-app\server\New-HomeOpsRemoteToken.ps1", "-Force -TokenOutputPath \"" + TokenPath + "\"");
        }

        private void RunApiGet(string path)
        {
            string response = Http("GET", ApiUrl(path), null, StatusRequestTimeoutMs);
            Append(response);
        }

        private void RunApiCommand(string action, string text)
        {
            string json = "{\"action\":\"" + EscapeJson(action) + "\",\"text\":\"" + EscapeJson(text) + "\"}";
            string response = Http("POST", ApiUrl("/api/commands"), json, CommandRequestTimeoutMs);
            Append(response);
        }

        private string ApiUrl(string path)
        {
            string baseUrl = apiUrlBox.Text.Trim().TrimEnd('/');
            return baseUrl + path;
        }

        private string Http(string method, string url, string body, int timeoutMs)
        {
            string token = ReadToken();
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = method;
            request.Timeout = timeoutMs;
            request.ReadWriteTimeout = timeoutMs;
            request.UserAgent = "HomeOpsRemoteLauncher/1.0";
            request.Headers["Authorization"] = "Bearer " + token;
            if (body != null)
            {
                byte[] data = Encoding.UTF8.GetBytes(body);
                request.ContentType = "application/json";
                request.ContentLength = data.Length;
                using (var stream = request.GetRequestStream())
                {
                    stream.Write(data, 0, data.Length);
                }
            }

            try
            {
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var stream = response.GetResponseStream())
                using (var reader = new StreamReader(stream))
                {
                    statusLabel.Text = method + " " + url + " -> " + (int)response.StatusCode;
                    return reader.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                var response = ex.Response as HttpWebResponse;
                if (response == null) throw;

                using (response)
                using (var stream = response.GetResponseStream())
                using (var reader = stream == null ? null : new StreamReader(stream))
                {
                    string responseBody = reader == null ? string.Empty : reader.ReadToEnd();
                    statusLabel.Text = method + " " + url + " -> " + (int)response.StatusCode;
                    return "HTTP " + (int)response.StatusCode + " " + response.StatusDescription + "\r\n" + responseBody;
                }
            }
        }

        private string ReadToken()
        {
            if (!File.Exists(TokenPath)) throw new FileNotFoundException("Token file not found", TokenPath);
            return File.ReadAllText(TokenPath).Trim();
        }

        private void RunPowerShellScript(string relativeScript, string arguments = "")
        {
            string scriptPath = Path.Combine(Root, relativeScript);
            RunPowerShell("-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\" " + arguments);
        }

        private void RunPowerShell(string arguments)
        {
            RunProcess(PowerShellPath, arguments, Root);
        }

        private void RunProcess(string fileName, string arguments, string workingDirectory)
        {
            Append("> " + fileName + " " + arguments);
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var process = Process.Start(psi))
            {
                string stdout = process.StandardOutput.ReadToEnd();
                string stderr = process.StandardError.ReadToEnd();
                process.WaitForExit();
                Append(stdout);
                if (!string.IsNullOrWhiteSpace(stderr)) Append("STDERR:\r\n" + stderr);
                Append("Exit code: " + process.ExitCode);
            }
        }

        private void OpenUrl(string url)
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }

        private void OpenDashboard()
        {
            OpenUrl(BuildDashboardUrl(apiUrlBox.Text.Trim()));
        }

        private string BuildDashboardUrl(string dashboardUrl)
        {
            string baseUrl = dashboardUrl.Trim().TrimEnd('/');
            string url = baseUrl + "/?launch=" + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            string token = ReadToken();
            return url + "#token=" + Uri.EscapeDataString(token) + "&apiUrl=" + Uri.EscapeDataString(baseUrl);
        }

        private void Append(string text)
        {
            if (string.IsNullOrEmpty(text)) return;
            logBox.AppendText("[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + text + "\r\n\r\n");
        }

        private static string EscapeJson(string value)
        {
            if (value == null) return string.Empty;
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
        }

        private static string Prompt(string text, string title)
        {
            using (var form = new Form())
            using (var label = new Label())
            using (var box = new TextBox())
            using (var ok = new Button())
            using (var cancel = new Button())
            {
                form.Text = title;
                form.Width = 520;
                form.Height = 180;
                form.StartPosition = FormStartPosition.CenterParent;
                label.Text = text;
                label.SetBounds(12, 12, 480, 24);
                box.SetBounds(12, 42, 480, 24);
                ok.Text = "OK";
                ok.DialogResult = DialogResult.OK;
                ok.SetBounds(316, 82, 82, 32);
                cancel.Text = "Cancel";
                cancel.DialogResult = DialogResult.Cancel;
                cancel.SetBounds(410, 82, 82, 32);
                form.Controls.AddRange(new Control[] { label, box, ok, cancel });
                form.AcceptButton = ok;
                form.CancelButton = cancel;
                return form.ShowDialog() == DialogResult.OK ? box.Text : string.Empty;
            }
        }
    }
}
