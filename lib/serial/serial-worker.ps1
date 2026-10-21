# Serial port reader for Mee JARVIS (System.IO.Ports, no native Node module).
# args  : -Port COM3 -Baud 9600   (validated by lib/serial/monitor.js before spawning)
# stdout: one line per received line, prefixed "L:" ; "E:<message>" on an error ; "R" once the port is open
param([Parameter(Mandatory = $true)][string]$Port, [Parameter(Mandatory = $true)][int]$Baud)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Send([string]$s) {
  [Console]::Out.WriteLine($s)
  [Console]::Out.Flush()
}

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
$sp.ReadTimeout = 500
$sp.NewLine = "`n"
$sp.DtrEnable = $false # opening with DTR high resets most Arduino boards
try {
  $sp.Open()
} catch {
  Send ('E:' + $_.Exception.Message)
  exit 1
}
Send 'R'
try {
  while ($true) {
    try {
      $line = $sp.ReadLine()
      Send ('L:' + $line.TrimEnd("`r"))
    } catch [System.TimeoutException] {
      # nothing arrived: keep waiting
    }
  }
} catch {
  Send ('E:' + $_.Exception.Message)
} finally {
  if ($sp.IsOpen) { $sp.Close() }
}
