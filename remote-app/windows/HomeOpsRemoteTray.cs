using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

namespace HomeOpsRemote
{
    internal static class TrayProgram
    {
        [STAThread]
        private static void Main()
        {
            bool created;
            using (var mutex = new Mutex(true, "HomeOpsRemoteTraySingleton", out created))
            {
                if (!created)
                {
                    return;
                }

                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext());
            }
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        private const string RemoteRoot = @"C:\Users\kth10\Documents\home-ops\remote-app";
        private const string NodePath = @"C:\Program Files\nodejs\node.exe";
        private const string DashboardUrl = "http://127.0.0.1:8787/";
        private const string BackendProbeUrl = "http://127.0.0.1:8787/";
        private const int BackendProbeTimeoutMs = 2000;
        private readonly string serverScript = Path.Combine(RemoteRoot, @"server\homeops-remote.mjs");
        private readonly string configPath = Path.Combine(RemoteRoot, @"config\homeops.remote.json");
        private readonly string tokenPath = Path.Combine(RemoteRoot, @"config\homeops.remote.token.txt");
        private readonly string logPath = Path.GetFullPath(Path.Combine(RemoteRoot, @"..\logs\homeops-remote-tray.log"));
        private readonly string trayIconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "homeops-remote.ico");
        private readonly Icon trayIconImage;
        private readonly NotifyIcon trayIcon;
        private readonly System.Windows.Forms.Timer monitorTimer;
        private Process nodeProcess;
        private bool exiting;
        private bool externalBackendLogged;

        public TrayContext()
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            trayIconImage = LoadTrayIcon();

            trayIcon = new NotifyIcon
            {
                Icon = trayIconImage,
                Text = "HomeOps Remote",
                Visible = true,
                ContextMenuStrip = BuildMenu()
            };
            trayIcon.DoubleClick += delegate { OpenDashboard(); };

            StartBackend();
            monitorTimer = new System.Windows.Forms.Timer { Interval = 10000 };
            monitorTimer.Tick += delegate { MonitorBackend(); };
            monitorTimer.Start();
        }

        private Icon LoadTrayIcon()
        {
            try
            {
                if (File.Exists(trayIconPath))
                {
                    return new Icon(trayIconPath, SystemInformation.SmallIconSize);
                }

                Icon embedded = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (embedded != null)
                {
                    return embedded;
                }
            }
            catch (Exception ex)
            {
                Log("Tray icon load failed: " + ex.Message);
            }

            return (Icon)SystemIcons.Application.Clone();
        }

        private ContextMenuStrip BuildMenu()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open dashboard", null, delegate { OpenDashboard(); });
            menu.Items.Add("Status", null, delegate { ShowStatus(); });
            menu.Items.Add("Restart backend", null, delegate { RestartBackend(); });
            menu.Items.Add("Open log", null, delegate { OpenLog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit tray", null, delegate { ExitTray(); });
            return menu;
        }

        private void StartBackend()
        {
            if (nodeProcess != null && !nodeProcess.HasExited)
            {
                return;
            }
            if (IsBackendReachable())
            {
                if (!externalBackendLogged)
                {
                    Log("Backend already reachable at " + BackendProbeUrl + "; not starting a duplicate node process.");
                    externalBackendLogged = true;
                }
                return;
            }

            if (!File.Exists(NodePath))
            {
                Log("Node not found: " + NodePath);
                trayIcon.ShowBalloonTip(5000, "HomeOps Remote", "Node was not found.", ToolTipIcon.Error);
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = NodePath,
                Arguments = "\"" + serverScript + "\" --config \"" + configPath + "\"",
                WorkingDirectory = RemoteRoot,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            nodeProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
            nodeProcess.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("OUT " + e.Data); };
            nodeProcess.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Log("ERR " + e.Data); };
            nodeProcess.Exited += delegate
            {
                Log("Node exited with code " + nodeProcess.ExitCode);
                if (!exiting)
                {
                    Log("Node will be restarted by the tray monitor.");
                }
            };

            nodeProcess.Start();
            nodeProcess.BeginOutputReadLine();
            nodeProcess.BeginErrorReadLine();
            externalBackendLogged = false;
            Log("Started node pid " + nodeProcess.Id);
        }


        private void MonitorBackend()
        {
            if (exiting) return;
            if (nodeProcess == null || nodeProcess.HasExited)
            {
                if (IsBackendReachable())
                {
                    if (!externalBackendLogged)
                    {
                        Log("Backend already reachable at " + BackendProbeUrl + "; not starting a duplicate node process.");
                        externalBackendLogged = true;
                    }
                    return;
                }

                Log("Monitor detected backend stopped; restarting.");
                StartBackend();
            }
        }

        private void RestartBackend()
        {
            StopBackend();
            StartBackend();
            trayIcon.ShowBalloonTip(2500, "HomeOps Remote", "Backend restarted.", ToolTipIcon.Info);
        }

        private void StopBackend()
        {
            if (nodeProcess == null || nodeProcess.HasExited) return;

            try
            {
                nodeProcess.Kill();
                nodeProcess.WaitForExit(5000);
                Log("Stopped node pid " + nodeProcess.Id);
            }
            catch (Exception ex)
            {
                Log("Stop failed: " + ex.Message);
            }
        }

        private void ShowStatus()
        {
            try
            {
                var status = nodeProcess != null && !nodeProcess.HasExited
                    ? "Backend running, pid " + nodeProcess.Id
                    : IsBackendReachable()
                    ? "Backend reachable at " + BackendProbeUrl
                    : "Backend stopped";
                trayIcon.ShowBalloonTip(5000, "HomeOps Remote", status, ToolTipIcon.Info);
                Log(status);
            }
            catch (Exception ex)
            {
                Log("Status failed: " + ex.Message);
            }
        }

        private void OpenDashboard()
        {
            Process.Start(new ProcessStartInfo { FileName = BuildDashboardUrl(), UseShellExecute = true });
        }

        private string BuildDashboardUrl()
        {
            string baseUrl = DashboardUrl.TrimEnd('/');
            string url = baseUrl + "/?launch=" + DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (!File.Exists(tokenPath))
            {
                Log("Token file not found when opening dashboard: " + tokenPath);
                return url;
            }

            string token = File.ReadAllText(tokenPath).Trim();
            return url + "#token=" + Uri.EscapeDataString(token) + "&apiUrl=" + Uri.EscapeDataString(baseUrl);
        }

        private bool IsBackendReachable()
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(BackendProbeUrl);
                request.Method = "GET";
                request.Timeout = BackendProbeTimeoutMs;
                request.ReadWriteTimeout = BackendProbeTimeoutMs;
                request.UserAgent = "HomeOpsRemoteTray/1.0";
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    return (int)response.StatusCode >= 200 && (int)response.StatusCode < 500;
                }
            }
            catch
            {
                return false;
            }
        }

        private void OpenLog()
        {
            Process.Start(new ProcessStartInfo { FileName = logPath, UseShellExecute = true });
        }

        private void ExitTray()
        {
            exiting = true;
            monitorTimer.Stop();
            StopBackend();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            ExitThread();
        }

        private void Log(string message)
        {
            File.AppendAllText(logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                monitorTimer.Dispose();
                trayIcon.Dispose();
                trayIconImage.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}

