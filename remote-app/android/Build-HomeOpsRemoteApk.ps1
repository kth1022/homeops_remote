[CmdletBinding()]
param(
    [string]$SdkRoot = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$OutputDirectory,
    [string]$VersionName = '1.0.0',
    [int]$VersionCode = 1
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$androidRoot = $PSScriptRoot
$remoteRoot = [System.IO.Path]::GetFullPath((Join-Path $androidRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $remoteRoot 'dist'
}

function Get-LatestDirectory {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Filter
    )
    $dir = Get-ChildItem -LiteralPath $Path -Directory -Filter $Filter -ErrorAction Stop |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($null -eq $dir) {
        throw "No directory matching $Filter under $Path"
    }
    return $dir.FullName
}

$platformDir = Get-LatestDirectory -Path (Join-Path $SdkRoot 'platforms') -Filter 'android-*'
$buildToolsDir = Get-LatestDirectory -Path (Join-Path $SdkRoot 'build-tools') -Filter '*'
$androidJar = Join-Path $platformDir 'android.jar'
$aapt2 = Join-Path $buildToolsDir 'aapt2.exe'
$d8 = Join-Path $buildToolsDir 'd8.bat'
$zipalign = Join-Path $buildToolsDir 'zipalign.exe'
$apksigner = Join-Path $buildToolsDir 'apksigner.bat'
$javac = 'C:\Program Files\Android\Android Studio\jbr\bin\javac.exe'
$jar = 'C:\Program Files\Android\Android Studio\jbr\bin\jar.exe'
$jbrRoot = 'C:\Program Files\Android\Android Studio\jbr'
$env:JAVA_HOME = $jbrRoot
$env:PATH = (Join-Path $jbrRoot 'bin') + ';' + $env:PATH
$keytool = Join-Path $jbrRoot 'bin\keytool.exe'

foreach ($tool in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
    if (-not (Test-Path -LiteralPath $tool)) {
        throw "Required Android build tool not found: $tool"
    }
}

$buildRoot = Join-Path $androidRoot 'build'
$compiled = Join-Path $buildRoot 'compiled'
$gen = Join-Path $buildRoot 'gen'
$classes = Join-Path $buildRoot 'classes'
$dex = Join-Path $buildRoot 'dex'
$unsignedApk = Join-Path $buildRoot 'HomeOpsRemote-unsigned.apk'
$dexApk = Join-Path $buildRoot 'HomeOpsRemote-dex.apk'
$alignedApk = Join-Path $buildRoot 'HomeOpsRemote-aligned.apk'
$finalApk = Join-Path $OutputDirectory 'HomeOpsRemote.apk'
$keystore = Join-Path $androidRoot 'homeops-remote-debug.keystore'
$resZip = Join-Path $compiled 'resources.zip'

if (Test-Path -LiteralPath $buildRoot) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $compiled, $gen, $classes, $dex, $OutputDirectory | Out-Null

if (-not (Test-Path -LiteralPath $keystore)) {
    & $keytool -genkeypair `
        -keystore $keystore `
        -storepass homeopsremote `
        -keypass homeopsremote `
        -alias homeopsremote `
        -keyalg RSA `
        -keysize 2048 `
        -validity 10000 `
        -dname 'CN=HomeOps Remote,O=HomeOps,L=Home,ST=Home,C=US' | Out-Null
}

& $aapt2 compile --dir (Join-Path $androidRoot 'src\main\res') -o $resZip
& $aapt2 link `
    -o $unsignedApk `
    -I $androidJar `
    --manifest (Join-Path $androidRoot 'src\main\AndroidManifest.xml') `
    --java $gen `
    --min-sdk-version 26 `
    --target-sdk-version 36 `
    --version-code $VersionCode `
    --version-name $VersionName `
    $resZip

$javaFiles = @()
$javaFiles += Get-ChildItem -LiteralPath (Join-Path $androidRoot 'src\main\java') -Recurse -Filter *.java -File | ForEach-Object { $_.FullName }
$javaFiles += Get-ChildItem -LiteralPath $gen -Recurse -Filter *.java -File | ForEach-Object { $_.FullName }
& $javac -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d $classes @javaFiles

$classFiles = Get-ChildItem -LiteralPath $classes -Recurse -Filter *.class -File | ForEach-Object { $_.FullName }
& $d8 --release --min-api 26 --output $dex @classFiles

Copy-Item -LiteralPath $unsignedApk -Destination $dexApk -Force
& $jar uf $dexApk -C $dex classes.dex
& $zipalign -f 4 $dexApk $alignedApk
& $apksigner sign `
    --ks $keystore `
    --ks-key-alias homeopsremote `
    --ks-pass pass:homeopsremote `
    --key-pass pass:homeopsremote `
    --out $finalApk `
    $alignedApk
& $apksigner verify --print-certs $finalApk

Write-Output "Wrote $finalApk"

