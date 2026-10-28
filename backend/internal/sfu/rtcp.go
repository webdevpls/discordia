package sfu

import "github.com/pion/rtcp"

func pliFor(ssrc uint32) []rtcp.Packet {
	return []rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}
}

func wantsKeyframe(pkts []rtcp.Packet) bool {
	for _, pkt := range pkts {
		switch pkt.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			return true
		}
	}
	return false
}
