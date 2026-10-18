# Persistent Windows OneCore (WinRT) speech synthesizer for Mee JARVIS.
# stdin : one JSON per line  {"id":1,"cmd":"speak","text_b64":"...","voice":"th-TH","rate":1.0}
#                            {"id":2,"cmd":"voices"}
# stdout: one JSON per line  {"id":1,"ok":true,"wav_b64":"..."} | {"id":1,"ok":false,"error":"..."}
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, [Type]$type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  return $t.Result
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

Send @{ id = 0; ok = $true; ready = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    if ($req.cmd -eq 'voices') {
      $list = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { @{ name = $_.DisplayName; lang = $_.Language; id = $_.Id } })
      Send @{ id = $id; ok = $true; voices = $list }
      continue
    }
    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.text_b64))
    $want = [string]$req.voice
    $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq $want -or $_.Id -eq $want } | Select-Object -First 1
    if (-not $voice) { $voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.Language -eq 'th-TH' } | Select-Object -First 1 }
    if (-not $voice) { Send @{ id = $id; ok = $false; error = 'NO_THAI_VOICE' }; continue }
    $synth.Voice = $voice
    if ($req.rate) { try { $synth.Options.SpeakingRate = [double]$req.rate } catch {} }
    # pitch resets every request (the synthesizer is reused); AudioPitch needs Win10 1803+
    $p = 1.0
    if ($req.pitch) { $p = [double]$req.pitch }
    try { $synth.Options.AudioPitch = $p } catch {}
    $stream = Await ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $null = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
    $bytes = New-Object byte[] ([int]$stream.Size)
    $reader.ReadBytes($bytes)
    $reader.Dispose(); $stream.Dispose()
    Send @{ id = $id; ok = $true; wav_b64 = [Convert]::ToBase64String($bytes); voice = $voice.DisplayName }
  } catch {
    Send @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
