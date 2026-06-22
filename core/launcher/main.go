// launcher.exe — Windows GUI-subsystem process launcher.
// Compiled with -ldflags="-H windowsgui" so Windows NEVER creates a console.
// Uses Win32 CreateProcess with CREATE_NO_WINDOW to spawn a hidden child.
//
// Usage: launcher.exe <executable> [args...]
// Exit:   0 on success, 1 on error

package main

import (
	"os"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(1)
	}

	exePath := os.Args[1]
	cmdLine := makeCmdLine(os.Args[1:])

	exePtr := mustUTF16Ptr(exePath)
	cmdPtr := mustUTF16Ptr(cmdLine)

	var si syscall.StartupInfo
	var pi syscall.ProcessInformation

	err := syscall.CreateProcess(
		exePtr,
		cmdPtr,
		nil,     // lpProcessAttributes
		nil,     // lpThreadAttributes
		false,   // bInheritHandles
		0x08000000, // CREATE_NO_WINDOW
		nil,     // lpEnvironment
		nil,     // lpCurrentDirectory
		&si,
		&pi,
	)
	if err != nil {
		os.Exit(1)
	}

	syscall.CloseHandle(pi.Process)
	syscall.CloseHandle(pi.Thread)
	os.Exit(0)
}

// makeCmdLine builds a Windows command line from argv by quoting
// arguments that contain spaces or special characters.
func makeCmdLine(args []string) string {
	line := ""
	for i, arg := range args {
		if i > 0 {
			line += " "
		}
		if needsQuoting(arg) {
			line += `"` + arg + `"`
		} else {
			line += arg
		}
	}
	return line
}

func needsQuoting(s string) bool {
	for _, c := range s {
		if c == ' ' || c == '\t' {
			return true
		}
	}
	return len(s) == 0
}

func mustUTF16Ptr(s string) *uint16 {
	ptr, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		panic(err)
	}
	return ptr
}
