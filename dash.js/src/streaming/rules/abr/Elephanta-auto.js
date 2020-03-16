import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import MediaPlayerModel from '../../models/MediaPlayerModel';
import PlaybackController from '../../controllers/PlaybackController';
import {HTTPRequest} from '../../vo/metrics/HTTPRequest';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import Debug from '../../../core/Debug';

const MINIMUM_BUFFER_S = 6;
const ELEPHANTA_AUTO_STATE = 1;
const REBUFFER_SAFETY_FACTOR = 0.9;
const DELAY_TIME = 5.1;
const SAFE_BUFFER_LEVEL = REBUFFER_SAFETY_FACTOR * 4;
const RICH_BUFFER_LEVEL = REBUFFER_SAFETY_FACTOR * 10;

function ElephantaAutoRule(config) {

	const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE = 2;
    const AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD = 3;
    const FIRST_CHUNK = 0;
	let dashMetrics = config.dashMetrics;
	let context = this.context;
    let eventBus = EventBus(context).getInstance();
    let metricsModel = config.metricsModel;
    let log = Debug(context).getInstance().log;
    let uors_factor = 1;
    let uors_factor_constant = 1;

	let instance,
		mediaPlayerModel,
        playbackController;

	function setup() {

		mediaPlayerModel = MediaPlayerModel(context).getInstance();
        playbackController = PlaybackController(context).getInstance();
        eventBus.on(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.on(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.on(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
	}

	function initializeElephantaAutoState() {
		let initialState = {};
		let virtual_queue_z1 = [];
		let virtual_queue_z2 = [];
		let virtual_queue_z3 = [];
		let virtual_queue_g = [];
		let time_slot = [];
		let bandwidth = [];
		let bandwidth_elapsedtime = [];
		let chunk_queue = [];
		let gamma = [];
		let download_time = 0;
		let chunk_number = 0;
		let bitrate_switch = 0;
		let rebuffer_times = 0;
		virtual_queue_g[0] = 0;
		virtual_queue_z1[0] = 0;
		virtual_queue_z2[0] = 0;
		virtual_queue_z3[0] = 0;
		let V = 0.5;
		let alpha1 = 5;
		let alpha2 = 10;
		let alpha3 = 3;
		let gamma_min = 1;
		let gamma_max = 7*Math.log(10);
		let c_1 = 0;
		let c_2 = 0;
		let c_3 = 0;
		//let T_exp_sup = NaN;
		let fragmentDuration = NaN;
		let selected_bitrate = NaN;
		let bitrate_list = [];
		let lastFragmentSuccess = true;

		initialState.state = ELEPHANTA_AUTO_STATE;

		initialState.virtual_queue_z1 = virtual_queue_z1;
		initialState.virtual_queue_z2 = virtual_queue_z2;
		initialState.virtual_queue_z3 = virtual_queue_z3;
		initialState.virtual_queue_g = virtual_queue_g;
		initialState.time_slot = time_slot;
		initialState.bandwidth = bandwidth;
		initialState.bandwidth_elapsedtime = bandwidth_elapsedtime;
		initialState.chunk_queue = chunk_queue;
		initialState.gamma = gamma;
		initialState.download_time = download_time;
		initialState.chunk_number = chunk_number;
		initialState.bitrate_switch = bitrate_switch;
		initialState.rebuffer_times = rebuffer_times;
		initialState.V = V;
		initialState.alpha1 = alpha1;
		initialState.alpha2 = alpha2;
		initialState.alpha3 = alpha3;
		initialState.gamma_min = gamma_min;
		initialState.gamma_max = gamma_max;
		initialState.c_1 = c_1;
		initialState.c_2 = c_2;
		initialState.c_3 = c_3;
		initialState.fragmentDuration = fragmentDuration;
		initialState.rebufferSafetyFactor = REBUFFER_SAFETY_FACTOR;
		initialState.minimum_buffer_level = MINIMUM_BUFFER_S;
		initialState.selected_bitrate = selected_bitrate;
		initialState.bitrate_list = bitrate_list;
		initialState.lastFragmentSuccess = lastFragmentSuccess;
		initialState.lastRepresentation = false;
		initialState.constraintsBO = 100;
		initialState.constraintsBS = 100;
		initialState.constraintsRB = 100;

		return initialState;
	}

	function getLastHttpRequests(metrics, count) {
		let allHttpRequests = dashMetrics.getHttpRequests(metrics);
        let httpRequests = [];

        for (let i = allHttpRequests.length - 1; i >= 0 && httpRequests.length < count; --i) {
            let request = allHttpRequests[i];
            if (request.type === HTTPRequest.MEDIA_SEGMENT_TYPE && request._tfinish && request.tresponse && request.trace) {
                httpRequests.push(request);
            }
        }

        return httpRequests;
	}

	function onBufferEmpty() {
		//reset();
	}

	function onPlaybackSeeking() {

    }

	function getRecentThroughput(metrics, count) {
		let lastRequests = getLastHttpRequests(metrics, count);
        if (lastRequests.length === 0) {
            return 0;
        }

        let totalInverse = 0;
        //let msg = '';
        for (var i = 0; i < lastRequests.length; ++i) {
            // The RTT delay results in a lower throughput. We can avoid this delay in the calculation, but we do not want to.
            let downloadSeconds = 0.001 * (lastRequests[i]._tfinish.getTime() - lastRequests[i].trequest.getTime());
            let downloadBits = 8 * lastRequests[i].trace.reduce((prev, cur) => (prev + cur.b[0]), 0);
            //if (BOLA_DEBUG) msg += ' ' + (0.000001 * downloadBits).toFixed(3) + '/' + downloadSeconds.toFixed(3) + '=' + (0.000001 * downloadBits / downloadSeconds).toFixed(3) + 'Mbps';
            totalInverse += downloadSeconds / downloadBits;
        }

        //if (BOLA_DEBUG) log('BolaDebug ' + mediaType + ' BolaRule recent throughput = ' + (lastRequests.length / (1000000 * totalInverse)).toFixed(3) + 'Mbps:' + msg);

        return lastRequests.length / totalInverse;
	}
	//auxiliary variables selection
	function auxiliary_selection(elephantaState) {
		let gamma_value;
		let g_count = elephantaState.chunk_number - 1;
		if(isNaN(g_count))	g_count = 0;
		let tem_gamma = elephantaState.V / elephantaAutoState.virtual_queue_g[g_count];
		if(tem_gamma < elephantaState.gamma_min) {
			gamma_value = elephantaState.gamma_min;
		} else {
			if (tem_gamma > elephantaState.gamma_max) {
				gamma_value = elephantaState.gamma_max;
			} else {
				gamma_value = tem_gamma;
			}
		}
		return gamma_value;
	}
	//choose optimal bitrate under UORS Metric
	function bitrate_selection(elephantaState, exp_bandwidth, buffer_level) {
		let min_val = Number.MAX_VALUE;
		let max_bitrate = 1;
		let current_time_slot_index = elephantaState.chunk_number - 1;
		if (current_time_slot_index < 0) current_time_slot_index = 0;
		let i;
		if(elephantaAutoState.chunk_number === FIRST_CHUNK) {
			for(i = 0; i < elephantaState.bitrate_list.length; i++) {
				if(elephantaState.bitrate_list[i] < exp_bandwidth) {
					max_bitrate = i;
				}
			}

			return max_bitrate;
        }
        if(buffer_level < SAFE_BUFFER_LEVEL) {
        	uors_factor = uors_factor + uors_factor_constant;
        }
        if(buffer_level > RICH_BUFFER_LEVEL) {
        	uors_factor = uors_factor / 2;
        }
        log("Expected bandwidth = " + exp_bandwidth + " buffer_level = " + buffer_level + "uors factor = " + uors_factor);
		log("Constraints weight: BS" + elephantaState.constraintsBS + "BO" + elephantaState.constraintsBO + "RB" + elephantaState.constraintsRB);
		for(i = 0; i < elephantaState.bitrate_list.length; i ++) {
			let exp_download_time = elephantaState.bitrate_list[i] / exp_bandwidth / Math.pow(REBUFFER_SAFETY_FACTOR,i);
			//if(exp_download_time > elephantaAutoState.fragmentDuration)	continue;
			let exp_buffer = buffer_level + elephantaState.fragmentDuration - exp_download_time;
			if(exp_download_time > buffer_level || exp_buffer < uors_factor * SAFE_BUFFER_LEVEL)	continue;
			let exp_y1 = penalty_drift(elephantaState.alpha1 * elephantaAutoState.constraintsBS/100, elephantaState.chunk_queue[elephantaState.chunk_number - 1], i);
			let exp_y2 = penalty_rebuffer(elephantaState.alpha2 * elephantaState.constraintsRB/100, exp_buffer - DELAY_TIME);
			let exp_y3 = penalty_bufferoccupancy(elephantaState.alpha3 * elephantaState.constraintsBO/100, exp_buffer - DELAY_TIME);
			let exp_T = elephantaState.bitrate_list[i] / exp_bandwidth;
			let exp_x = Math.pow(i,2);
			let val = (elephantaState.virtual_queue_z1[current_time_slot_index] * exp_y1 + elephantaState.virtual_queue_z2[current_time_slot_index] * exp_y2 + elephantaState.virtual_queue_z3[current_time_slot_index]*exp_y3 - elephantaState.virtual_queue_g[current_time_slot_index] * exp_x)/exp_T;
			log("Penalty of chunk number:" + elephantaState.chunk_number + " recycle index: " + i + " value is " + val + "Expected buffer = " + exp_buffer + "exp_download_time: " + exp_download_time);
			if(val < min_val) {
				max_bitrate = i;
            	min_val = val;
			}
		}
		let selected_bitrate = max_bitrate;
		//let selected_bitrate = 0;
		return selected_bitrate;
	}

	//
	function getMaxIndex(rulesContext) {
		let streamProcessor = rulesContext.getStreamProcessor();
        streamProcessor.getScheduleController().setTimeToLoadDelay(0);
        let switchRequest = SwitchRequest(context).create(SwitchRequest.NO_CHANGE, SwitchRequest.WEAK, {name: ElephantaAutoRule.__dashjs_factory_name});
        let trackInfo = rulesContext.getTrackInfo();
        let mediaInfo = rulesContext.getMediaInfo();
        let mediaType = mediaInfo.type;
        let metrics = metricsModel.getReadOnlyMetricsFor(mediaType);
        let isDynamic = streamProcessor.isDynamic();
        let fragmentDuration = trackInfo.fragmentDuration;

        if(mediaType === 'audio') {
        	return switchRequest;
        }

        if(metrics.elephantaState.length === 0)
        {
        	let initialState = initializeElephantaAutoState();
        	initialState.constraintsBO = mediaPlayerModel.getConstraintsBO();
	        initialState.constraintsBS = mediaPlayerModel.getConstraintsBS();
	        initialState.constraintsRB = mediaPlayerModel.getConstraintsRB();
        	metricsModel.updateElephantaAutoState(mediaType, initialState);
        }
        let elephantaAutoState = metrics.ElephantaAutoState[0]._s;
        elephantaAutoState.fragmentDuration = fragmentDuration;
        elephantaAutoState.bitrate_list = mediaInfo.bitrateList.map(b => b.bandwidth);
        let temp_rb_c = 1;
        let temp_bo_c = 1;
        let temp_bs = 1;
        //elephantaAutoState.constraintsBO = mediaPlayerModel.getConstraintsBO();
        //elephantaAutoState.constraintsBS = mediaPlayerModel.getConstraintsBS();
        //elephantaAutoState.constraintsRB = mediaPlayerModel.getConstraintsRB();
        if(elephantaAutoState.buffer_occupancy > 10) {
            temp_bo_c = 0.5;
            temp_rb_c = 0.5
        }
        if(elephantaAutoState.buffer_occupancy > 30) {
            temp_bo_c = 1;
            temp_rb_c = 0.1
        }
        elephantaAutoState.constraintsBO = temp_bo_c;
        elephantaAutoState.constraintsBS = temp_bs;
        elephantaAutoState.constraintsRB = temp_rb_c;

        metricsModel.updateElephantaAutoState(mediaType, elephantaAutoState);

        if (elephantaAutoState.chunk_number !== FIRST_CHUNK) {
        	//update virtual queue, dealing with last request.
	        let lastRequests = getLastHttpRequests(metrics, 1);
	        if (lastRequests.length === 0) {
	        	log('ElephantaAuto: last requests length 0, Chunk_number: ' + elephantaAutoState.chunk_number +' selected_bitrate: '+ elephantaAutoState.selected_bitrate);
	        	metricsModel.updateElephantaAutoState(mediaType, elephantaAutoState);
	        	//switchRequest;
	            return;
	        }
	        let lastRequest = lastRequests[0];
	        let lastTimeSlotLength = lastRequest.interval / 1000;
        	//update virtual queue
	        let m_t = lastTimeSlotLength;
	        log('ElephantaAuto: last time slot length = ' + m_t);
	        let m_y1;
	        if (elephantaAutoState.chunk_number < 2) {
	        	m_y1 = 0;
	        } else {
	        	m_y1 = penalty_drift(elephantaAutoState.alpha1 * elephantaAutoState.constraintsBS/100, elephantaAutoState.chunk_queue[elephantaAutoState.chunk_number - 1], elephantaAutoState.chunk_queue[elephantaAutoState.chunk_number - 2]);
	        }
	        let m_y2 = penalty_rebuffer(elephantaAutoState.alpha2 * elephantaAutoState.constraintsRB/100, elephantaAutoState.buffer_occupancy);
	        let m_y3 = penalty_bufferoccupancy(elephantaAutoState.alpha3 * elephantaAutoState.constraintsBO/100, elephantaAutoState.buffer_occupancy);
	        let m_x_m = gain(elephantaAutoState.selected_bitrate + 1);
	        elephantaAutoState.virtual_queue_z1[elephantaAutoState.chunk_number] = Math.max(elephantaAutoState.virtual_queue_z1[elephantaAutoState.chunk_number - 1] + m_y1 - m_t * elephantaAutoState.c_1, 0);
	        elephantaAutoState.virtual_queue_z2[elephantaAutoState.chunk_number] = Math.max(elephantaAutoState.virtual_queue_z2[elephantaAutoState.chunk_number - 1] + m_y2 - m_t * elephantaAutoState.c_2, 0);
	        elephantaAutoState.virtual_queue_z3[elephantaAutoState.chunk_number] = Math.max(elephantaAutoState.virtual_queue_z3[elephantaAutoState.chunk_number - 1] + m_y3 - m_t * elephantaAutoState.c_3, 0);
	        elephantaAutoState.virtual_queue_g[elephantaAutoState.chunk_number] = Math.max(elephantaAutoState.virtual_queue_g[elephantaAutoState.chunk_number - 1] - m_x_m + m_t * elephantaAutoState.gamma, 0);
        }
        //update
        //let T_exp_sup = Math.max(elephantaAutoState.bitrate_list[elephantaAutoState.bitrate_list.length - 1]/ elephantaAutoState.bitrate_list[0], EXP_BUFFER_SIZE);
        //let y1_exp_sup = elephantaAutoState.alpha1 * (elephantaAutoState.bitrate_list.length - 1);
        //let y2_exp_sup = elephantaAutoState.alpha2 * elephantaAutoState.alpha2;
        //let y3_exp_sup = elephantaAutoState.alpha3 * EXP_BUFFER_SIZE;
        //elephantaAutoState.c_1 = y1_exp_sup / T_exp_sup;
        //elephantaAutoState.c_2 = y2_exp_sup / T_exp_sup;
        //elephantaAutoState.c_3 = y3_exp_sup / T_exp_sup;
        elephantaAutoState.c_1 = 3;
        elephantaAutoState.c_2 = 1;
        elephantaAutoState.c_3 = 0.5;

        //average_utility += elephantaAutoState.selected_bitrate;
        //length measured in chunk number
        elephantaAutoState.buffer_occupancy = dashMetrics.getCurrentBufferLevel(metrics) ? dashMetrics.getCurrentBufferLevel(metrics) : 0;
        let throughputCount = (isDynamic ? AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_LIVE : AVERAGE_THROUGHPUT_SAMPLE_AMOUNT_VOD);
        let expThroughput = getRecentThroughput(metrics, throughputCount);
       /* if(EXP_BUFFER_SIZE - elephantaAutoState.buffer_occupancy < MINIMUM_BUFFER_S) {
        	metricsModel.updateelephantaAutoState(mediaType, elephantaAutoState);
        	callback(null);
        	return;
        }*/

        elephantaAutoState.selected_bitrate = bitrate_selection(elephantaAutoState, expThroughput, elephantaAutoState.buffer_occupancy);
        elephantaAutoState.gamma = auxiliary_selection(elephantaAutoState);
        elephantaAutoState.chunk_queue[elephantaAutoState.chunk_number] = elephantaAutoState.selected_bitrate;
        switchRequest.value = elephantaAutoState.selected_bitrate;
        switchRequest.priorty = switchRequest.DEFAULT;
    	elephantaAutoState.chunk_number += 1;
    	log('UORS:Chunk_number: ' + elephantaAutoState.chunk_number +' selected_bitrate: '+ elephantaAutoState.selected_bitrate);
    	elephantaAutoState.lastFragmentSuccess = false;
    	metricsModel.updateelephantaAutoState(mediaType, elephantaAutoState);
        return switchRequest;
	}

	//penalty defination of rebuffer
	function penalty_rebuffer(alpha, buffer_occupancy) {
		if(buffer_occupancy < 1)	return Math.pow(alpha,5);
		return alpha * alpha * Math.log(buffer_occupancy);
	}

	//penalty defination of bitrate drift
	function penalty_drift(alpha,chunk_1,chunk_2) {
		let penalty = alpha * Math.abs(chunk_1 - chunk_2);
		return penalty;
	}

	//penalty defination of buffer occupancy
	function penalty_bufferoccupancy(alpha,buffer_level) {
		if(buffer_level < 0.1) {
			buffer_level = 0;
		}
		let penalty = buffer_level * alpha;
		return penalty;
	}

	/*/benefit defination of attribute values
	function phi_attr(attributes) {
		let result = 0;
		for (var i = attributes.length - 1; i >= 0; i--) {
			resutl += attributes[i];
		}
		return result;
	}*/

	//efficient gain of amounts of data,measured in bitrate
	function gain(bitrates) {
		return Math.log(bitrates);
	}

	function reset() {
        eventBus.off(Events.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.off(Events.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        //eventBus.off(Events.PERIOD_SWITCH_STARTED, onPeriodSwitchStarted, instance);
        setup();
    }

	instance = {
		getMaxIndex: getMaxIndex,
		reset: reset
	};
	setup();
	return instance;
}

ElephantaAutoRule.__dashjs_factory_name = 'ElephantaAutoRule';
let factory = FactoryMaker.getClassFactory(ElephantaAutoRule);
export default factory;
