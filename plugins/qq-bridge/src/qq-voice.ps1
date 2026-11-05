param([Parameter(Mandatory=$true)][string]$TextFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$voiceText=[IO.File]::ReadAllText($TextFile,[Text.Encoding]::UTF8)
if (-not $voiceText -or $voiceText.Length -gt 1000) { throw 'Voice text is empty or too long.' }
$voiceSynth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($voiceText -match '[\u4e00-\u9fff]') {
        $voiceChinese=@($voiceSynth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' })
        if ($voiceChinese.Count -eq 0) { throw 'No local Chinese speech voice is installed.' }
        $voiceSynth.SelectVoice($voiceChinese[0].VoiceInfo.Name)
    }
    $voiceSynth.SetOutputToWaveFile($OutputFile)
    $voiceSynth.Speak($voiceText)
} finally { $voiceSynth.Dispose() }
