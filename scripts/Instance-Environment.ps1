param([ValidateSet('Main','Test')][string]$Instance='Main')
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$OutputEncoding=[Console]::OutputEncoding
$instanceEnvRoot=Split-Path -Parent $PSScriptRoot
$env:AI_FRIEND_INSTANCE=$Instance.ToLowerInvariant()
$instanceEnvDirectory=if ($Instance -eq 'Test') {'test'} else {'dev'}
$env:DSH_HOME=Join-Path $instanceEnvRoot ('runtime\'+$instanceEnvDirectory+'\dsh-home')
$env:MNEMON_DATA_DIR=Join-Path $instanceEnvRoot ('runtime\'+$instanceEnvDirectory+'\memory\native-default')
$env:NO_PROXY=(@($env:NO_PROXY,'127.0.0.1','127.0.0.2','localhost') | Where-Object { $_ }) -join ','
if ($Instance -eq 'Test') { Get-ChildItem Env: | Where-Object { $_.Name -match '^(BILIBILI_|NAPCAT_|ONEBOT_)' } | ForEach-Object { Remove-Item -LiteralPath ('Env:\'+$_.Name) } }
