@echo off
rem Cria (ou recria) a tarefa agendada do radar: scan a cada 6 horas com alertas.
setlocal
set "TASK=FreeApiRadar"
set "CMD_PATH=%~dp0scan-task.cmd"

schtasks /Create /F /TN "%TASK%" /SC HOURLY /MO 6 /TR "%CMD_PATH%"
if errorlevel 1 (
  echo.
  echo Falhou ao criar a tarefa. Rode este arquivo como o mesmo usuario do painel.
  exit /b 1
)

echo.
echo Tarefa "%TASK%" criada: a cada 6 horas.
schtasks /Query /TN "%TASK%" /FO LIST
echo.
echo Para rodar agora:  schtasks /Run /TN "%TASK%"
echo Para remover:      schtasks /Delete /TN "%TASK%" /F
